const express = require('express');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { queueEmail } = require('../lib/emailOutbox');
const { vorabText, ackText, notifyText } = require('../lib/inquiryMails');

// Anfragen aus dem Kontaktformular der Webseite (lorenalienhard.ch).
//   POST /api/inquiry                      oeffentlich, mit geheimem Schluessel (INQUIRY_KEY)
//   GET  /api/inquiries                    Beraterin: Liste (Status "Anfrage" in Kunden)
//   POST /api/inquiries/:id/vorab          Beraterin: Vorab-E-Mail senden (Du oder Sie)
//   POST /api/inquiries/:id/archive        Beraterin: Anfrage ablegen
const publicRouter = express.Router();
const advisorRouter = express.Router();

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT NOT NULL,
      message TEXT,
      source TEXT DEFAULT 'webseite',
      status TEXT NOT NULL DEFAULT 'neu',
      anrede TEXT,
      workshop_date TEXT,
      ack_sent_at TIMESTAMPTZ,
      vorab_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  tableEnsured = true;
}

const ALLOWED_ORIGINS = ['https://rhetoriq.ch', 'https://www.rhetoriq.ch'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const inquiryLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});

publicRouter.post('/', inquiryLimit, async (req, res) => {
  try {
    // Zugelassen sind (a) Aufrufe mit dem geheimen Schlüssel (INQUIRY_KEY, für Server-zu-Server)
    // und (b) Absendungen aus dem Anfrageformular der eigenen Landingpage (Absenderprüfung).
    const secret = process.env.INQUIRY_KEY;
    const given = req.headers['x-inquiry-key'] || req.body.key;
    const keyOk = !!secret && !!given && sameKey(given, secret);
    const origin = String(req.headers.origin || req.headers.referer || '');
    const fromSite = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + '/'));
    if (!keyOk && !fromSite) return res.status(401).json({ error: 'Nicht erlaubt.' });

    // Honeypot: dieses versteckte Feld füllen nur Bots aus.
    if (req.body.website2) return res.json({ ok: true });
    // Zeitfalle: Menschen brauchen mehr als 2 Sekunden bis zum Absenden.
    if (!keyOk && !(Number(req.body.elapsed) >= 2000)) return res.json({ ok: true });

    const name = clip(req.body.name, 120);
    const email = clip(req.body.email, 200).toLowerCase();
    const company = clip(req.body.company, 160);
    const message = clip(req.body.message, 4000);
    if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Name und gültige E-Mail erforderlich.' });

    await ensureTable();
    // Nur eine identische Nachricht derselben Adresse innert 10 Minuten gilt als Doppelklick.
    const dup = await pool.query(
      `SELECT id FROM inquiries WHERE email=$1 AND COALESCE(message,'')=$2 AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`, [email, message]);
    if (dup.rows.length) return res.json({ ok: true });

    const flood = await pool.query(`SELECT COUNT(*)::int AS n FROM inquiries WHERE created_at > NOW() - INTERVAL '1 hour'`);
    if (flood.rows[0].n >= 60) return res.json({ ok: true });
    const ackRecent = await pool.query(
      `SELECT (SELECT COUNT(*) FROM inquiries WHERE email=$1 AND ack_sent_at > NOW() - INTERVAL '24 hours')::int AS same,
              (SELECT COUNT(*) FROM inquiries WHERE ack_sent_at > NOW() - INTERVAL '1 hour')::int AS hour`, [email]);
    const sendAck = ackRecent.rows[0].same === 0 && ackRecent.rows[0].hour < 30;
    const { rows } = await pool.query(
      `INSERT INTO inquiries (name, company, email, message) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, company, email, message]);
    const id = rows[0].id;

    // Eingangsbestätigung an die Anfragende Person (Sie-Form, weil noch nichts geklärt ist).
    const ack = ackText({ name });
    if (sendAck) queueEmail({ kind: 'inquiry_ack', to: email, subject: 'Ihre Anfrage bei RhetorIQ', text: ack, senderName: 'Lorena Lienhard' })
      .then(() => pool.query('UPDATE inquiries SET ack_sent_at=NOW() WHERE id=$1', [id]))
      .catch(e => console.error('[inquiry] ack failed:', e.message));

    // Hinweis an die Beraterin.
    const notifyTo = process.env.ADVISOR_NOTIFY_EMAIL || process.env.SMTP_FROM || 'contact@lorenalienhard.ch';
    const note = notifyText({ name, company, email, message });
    queueEmail({ kind: 'inquiry_notify', to: notifyTo, subject: `Neue Anfrage: ${company || name}`, text: note })
      .catch(e => console.error('[inquiry] notify failed:', e.message));

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, company, email, message, status, anrede, workshop_date, ack_sent_at, vorab_sent_at, created_at
       FROM inquiries WHERE status != 'archiviert' ORDER BY created_at DESC LIMIT 100`);
    // Zusatzfeld draft_id (Onboarding-Entwurf zur Anfrage). Das bisherige Format bleibt unverändert;
    // schlägt die Zusatzabfrage fehl, wird die Liste wie bisher geliefert.
    try {
      await require('../lib/schemaRedesign').ensureSchema();
      const d = await pool.query(
        `SELECT inquiry_id, MAX(id) AS draft_id FROM onboarding_drafts WHERE inquiry_id IS NOT NULL GROUP BY inquiry_id`);
      const byInq = new Map(d.rows.map(r => [r.inquiry_id, r.draft_id]));
      rows.forEach(r => { r.draft_id = byInq.get(r.id) || null; });
    } catch (e2) { console.error('[inquiries] draft_id lookup failed:', e2.message); }
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.post('/:id/vorab', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    const id = parseInt(req.params.id, 10);
    const anrede = req.body.anrede === 'du' ? 'du' : 'sie';
    const titel = ['Frau', 'Herr'].includes(req.body.titel) ? req.body.titel : '';
    const datum = clip(req.body.datum, 80);
    if (!datum) return res.status(400).json({ error: 'Bitte den Workshop-Termin angeben.' });
    const { rows } = await pool.query('SELECT * FROM inquiries WHERE id=$1', [id]);
    const q = rows[0];
    if (!q) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
    const text = vorabText({ name: q.name, anrede, titel, datum });
    await queueEmail({ kind: 'inquiry_vorab', to: q.email, subject: `Unser Workshop am ${datum}`, text, senderName: 'Lorena Lienhard' });
    await pool.query(
      `UPDATE inquiries SET status='vorab_gesendet', anrede=$1, workshop_date=$2, vorab_sent_at=NOW() WHERE id=$3`,
      [anrede, datum, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.post('/:id/archive', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    await pool.query(`UPDATE inquiries SET status='archiviert' WHERE id=$1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Anfrage endgültig löschen (Name, E-Mail und Nachricht werden entfernt).
advisorRouter.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    const r = await pool.query('DELETE FROM inquiries WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { publicRouter, advisorRouter, ensureTable };
