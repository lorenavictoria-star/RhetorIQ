const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { generateText, resolveModelId } = require('../lib/aiProvider');
const budget = require('../lib/budget');
const { COST_SQL } = require('../lib/meter');
const A = require('../lib/assistent');
const assembly = require('../lib/assemblyai');

// Assistent der Beraterin (nur Rolle advisor).
//  GET  /api/assistent/tag      Tagesübersicht aus vorhandenen Daten, ohne KI
//  POST /api/assistent/befehl   { text } -> geprüfte Aktion aus einer festen Liste
//  POST /api/assistent/sprache  Audio (multipart, Feld "audio") -> { text }; nichts wird gespeichert
const router = express.Router();
const MAX_AUDIO = 4 * 1024 * 1024; // 30 Sekunden Sprache sind deutlich kleiner

const keyOf = (req) => `assistent_${req.user && req.user.id}`;
const limiter = (max) => rateLimit({
  windowMs: 60 * 1000, max, keyGenerator: keyOf, validate: { keyGeneratorIpFallback: false },
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
});
const befehlLimit = limiter(20);
const spracheLimit = limiter(12);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 2 } });

router.get('/tag', requireAdvisor, async (req, res) => {
  try {
    const aid = req.user.id;
    const [fr, an, ko] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN r.created_at < $2 THEN 1 ELSE 0 END),0)::int AS alt
                  FROM review_requests r JOIN clients c ON c.id = r.client_id
                  WHERE c.advisor_id = $1 AND c.geloescht_am IS NULL AND r.status = 'pending'`, [aid, new Date(Date.now() - 24 * 3600 * 1000)]),
      pool.query(`SELECT COUNT(*)::int AS n FROM inquiries WHERE status = 'neu'`),
      pool.query(`SELECT COALESCE(SUM(${COST_SQL}),0)::float AS c FROM usage_log WHERE created_at >= $1`, [budget.tagesbeginn().start])
    ]);
    const budgets = [];
    for (const name of Object.keys(budget.FUNKTIONEN)) {
      try {
        const spent = await budget.spentToday(name);
        if (spent >= budget.limitFor(name)) budgets.push({ name, label: budget.FUNKTIONEN[name].label });
      } catch { /* Prüfung darf die Übersicht nie verhindern */ }
    }
    const d = { offeneFreigaben: fr.rows[0].n, ueberfaellig: fr.rows[0].alt, neueAnfragen: an.rows[0].n, kostenHeute: ko.rows[0].c, budgets };
    res.json({ ...d, text: A.tagesText(d) });
  } catch (e) {
    console.error('[assistent] Tagesübersicht fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Die Übersicht konnte nicht geladen werden.' });
  }
});

router.post('/befehl', requireAdvisor, befehlLimit, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return res.status(400).json({ error: 'Bitte einen Befehl eingeben.' });
    if (text.length > A.MAX_BEFEHL) return res.status(400).json({ error: `Der Befehl darf höchstens ${A.MAX_BEFEHL} Zeichen lang sein.` });
    if (!(await budget.allow('assistent')).ok) return res.status(429).json({ error: 'Der Assistent ist für heute ausgeschöpft. Du erreichst alles weiterhin über die Seitenleiste.' });
    const { rows } = await pool.query('SELECT id, name FROM clients WHERE advisor_id = $1 AND geloescht_am IS NULL ORDER BY name', [req.user.id]);
    const hilfe = require('./helpChat').ROLLE.advisor;
    let roh = '';
    try {
      const resp = await generateText({
        system: A.baueSystem(hilfe, new Date()),
        messages: [{ role: 'user', content: A.baueNutzer(text, rows.map(r => r.name)) }],
        maxTokens: 400,
        model: resolveModelId('haiku'),
        temperature: 0,
        meter: { module: 'assistent', advisorId: req.user.id }
      });
      roh = String(resp?.text || '');
    } catch (e) {
      console.error('[assistent] KI fehlgeschlagen:', e.message);
      return res.status(502).json({ error: 'Der Assistent ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.' });
    }
    const settings = await require('../lib/tagesplanDaten').einstellungen(req.user.id).catch(() => undefined);
    const aktion = A.pruefeAktion(roh, rows, { settings });
    res.json({ aktion, antwort: A.antwortFuer(aktion) });
  } catch (e) {
    console.error('[assistent] Befehl fehlgeschlagen:', e.message);
    res.status(502).json({ error: 'Der Assistent ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.' });
  }
});

function einlesen(req, res, next) {
  upload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Die Aufnahme ist zu lang. Bitte sprich höchstens 30 Sekunden.' });
    return res.status(400).json({ error: 'Die Aufnahme konnte nicht gelesen werden.' });
  });
}

router.post('/sprache', requireAdvisor, spracheLimit, einlesen, async (req, res) => {
  try {
    if (!process.env.ASSEMBLYAI_API_KEY) return res.status(503).json({ error: 'Die Spracherkennung ist nicht eingerichtet. Du kannst den Befehl eintippen.' });
    const f = req.file;
    if (!f || !f.buffer || f.buffer.length < 200) return res.status(400).json({ error: 'Es kam keine Aufnahme an. Bitte versuche es noch einmal.' });
    if (!/^(audio|video)\//i.test(f.mimetype || '')) return res.status(400).json({ error: 'Das ist keine Audioaufnahme.' });
    const text = await assembly.transkribiere(f.buffer);
    if (!text) return res.status(422).json({ error: 'Ich habe nichts verstanden. Bitte sprich etwas lauter oder tippe den Befehl.' });
    res.json({ text: text.slice(0, A.MAX_BEFEHL) });
  } catch (e) {
    console.error('[assistent] Spracherkennung fehlgeschlagen:', e.message);
    res.status(502).json({ error: 'Die Spracherkennung ist gerade nicht erreichbar. Du kannst den Befehl eintippen.' });
  }
});

module.exports = router;
