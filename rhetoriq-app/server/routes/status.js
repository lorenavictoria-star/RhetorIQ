// Öffentlicher Zustand der KI und Schalter der Beraterin (ohne Deploy).
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { getStatus, setStatus } = require('../lib/systemStatus');
const { allowedClientId } = require('../middleware/ownership');
const { pool } = require('../db');

const router = express.Router();

// Ohne Anmeldung, keine Details: nur ok oder gestoert (plus Text, den die Beraterin selbst gesetzt hat)
router.get('/', async (req, res) => {
  const auto = (await getStatus('ki_stoerung', false)) === true;
  const man = await getStatus('hinweis_manuell', null);
  const manuell = !!(man && man.an);
  const out = { ki: auto || manuell ? 'gestoert' : 'ok' };
  if (manuell && man.text) out.hinweis = String(man.text).slice(0, 500);
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

router.get('/manuell', requireAdvisor, async (req, res) => {
  const w = await getStatus('hinweis_manuell', { an: false, text: '' });
  const wd = await getStatus('ki_waechter', null);
  res.json({ ...w, waechter: wd ? { fails: wd.fails, stoerung: wd.stoerung, lastOk: wd.lastOk, lastFail: wd.lastFail } : null });
});

router.put('/manuell', requireAdvisor, async (req, res) => {
  const an = req.body && req.body.an === true;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  await setStatus('hinweis_manuell', { an, text });
  res.json({ ok: true, an, text });
});

// Reservekonto (zweiter Anthropic-Schlüssel ANTHROPIC_API_KEY_2) von Hand erzwingen, ohne Deploy
router.get('/reserve', requireAdvisor, async (req, res) => {
  const st = await getStatus('ai_reserve_erzwingen', { an: false });
  res.json({ erzwingen: !!(st && st.an), reserveSchluesselGesetzt: !!process.env.ANTHROPIC_API_KEY_2 });
});

router.put('/reserve', requireAdvisor, async (req, res) => {
  const an = !!(req.body && req.body.an === true);
  await setStatus('ai_reserve_erzwingen', { an });
  try { const p = require('../lib/aiProvider'); if (typeof p.resetReserveCache === 'function') p.resetReserveCache(); } catch { /* Zwischenspeicher läuft nach 10 Sekunden ab */ }
  res.json({ ok: true, erzwingen: an, reserveSchluesselGesetzt: !!process.env.ANTHROPIC_API_KEY_2 });
});

// Selbsttest nach einer Störung: genau drei kurze Aufrufe (E-Mail, LinkedIn, Brief), keine Einträge in analyses.
// Gemeldet werden Erfolg, Dauer und geschätzte Kosten je Textart, nie der erzeugte Text oder Inhalte des Klienten.
const SELBSTTEST_ARTEN = [
  { art: 'E-Mail', auftrag: 'Schreibe eine sehr kurze E-Mail (zwei Sätze), die einen Termin bestätigt.' },
  { art: 'LinkedIn', auftrag: 'Schreibe einen sehr kurzen LinkedIn-Beitrag (zwei Sätze) zu einem Jubiläum.' },
  { art: 'Brief', auftrag: 'Schreibe einen sehr kurzen Brief (drei Sätze) mit Anrede und Gruss, der für eine Anfrage dankt.' }
];
let selbsttestLaeuft = false;

router.post('/selbsttest', requireAdvisor, async (req, res) => {
  if (selbsttestLaeuft) return res.status(429).json({ error: 'Ein Selbsttest läuft bereits.' });
  const body = req.body || {};
  let clientId = null;
  if (body.clientId != null && body.clientId !== '') {
    clientId = await allowedClientId(req, body.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
  }
  selbsttestLaeuft = true;
  try {
    const ai = require('../lib/aiProvider');
    const meter = require('../lib/meter');
    let voice = '';
    if (clientId) {
      const { rows } = await pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type='brand_voice'`, [clientId]).catch(() => ({ rows: [] }));
      voice = rows[0] && rows[0].content ? String(rows[0].content).slice(0, 600) : '';
    }
    const system = 'Du schreibst kurze Geschäftstexte auf Deutsch mit Schweizer Rechtschreibung.' + (voice ? `\nStimme des Absenders (Auszug):\n${voice}` : '');
    const model = ai.resolveModelId('sonnet');
    const results = [];
    let total = 0;
    for (const t of SELBSTTEST_ARTEN) {
      const t0 = Date.now();
      try {
        const r = await ai.generateText({
          system, messages: [{ role: 'user', content: t.auftrag }], maxTokens: 150, model,
          meter: { module: 'selbsttest', advisorId: req.user.id, clientId }
        });
        const kosten = meter.costUsd({ model: r.model || model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheCreationTokens: r.cacheCreationTokens, cacheReadTokens: r.cacheReadTokens });
        total += kosten;
        const ok = !!(r.text && r.text.trim());
        results.push({ art: t.art, ok, ms: Date.now() - t0, kostenUsd: kosten, reserve: r.reserve === true, fehler: ok ? null : 'Leere Antwort' });
      } catch (e) {
        results.push({ art: t.art, ok: false, ms: Date.now() - t0, kostenUsd: 0, reserve: false, fehler: String(e.message || e).slice(0, 160) });
      }
    }
    res.json({ ok: results.every(r => r.ok), results, kostenUsdTotal: Math.round(total * 1e6) / 1e6, mitKlient: !!clientId });
  } finally {
    selbsttestLaeuft = false;
  }
});

module.exports = router;
