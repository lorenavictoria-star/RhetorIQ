// Finanzaufstellung der Beraterin: Einnahmen, Kosten, Ergebnis je Monat. Nur für die Beraterin, nur eigene Klienten.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const fin = require('../lib/finanzen');

const router = express.Router();

let stripeOverride = null; // Tests setzen hier eine Attrappe
function getStripe() {
  if (stripeOverride) return stripeOverride;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => 'adv:' + ((req.user && req.user.id) || 'x'), validate: { keyGeneratorIpFallback: false },
  message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
});

router.use(requireAdvisor, limiter);

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;
function monat(req) { return MONAT.test(String(req.query.month || '')) ? String(req.query.month) : new Date().toISOString().slice(0, 7); }
function fail(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  console.error('[finanzen]', e && e.message);
  res.status(500).json({ error: 'Die Finanzaufstellung konnte nicht erstellt werden. Bitte versuche es in einer Minute erneut.' });
}

// GET /api/finanzen?month=2026-10&refresh=1
router.get('/', async (req, res) => {
  try { res.json(await fin.bericht(req.user.id, monat(req), { getStripe, refresh: req.query.refresh === '1' })); }
  catch (e) { fail(res, e); }
});

// GET /api/finanzen/export.csv und /export.docx
router.get('/export.csv', async (req, res) => {
  try {
    const b = await fin.bericht(req.user.id, monat(req), { getStripe });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Finanzaufstellung-${b.month}.csv"`);
    res.send(fin.toCsv(b));
  } catch (e) { fail(res, e); }
});
router.get('/export.docx', async (req, res) => {
  try {
    const b = await fin.bericht(req.user.id, monat(req), { getStripe });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Finanzaufstellung-${b.month}.docx"`);
    res.send(await fin.toDocx(b));
  } catch (e) { fail(res, e); }
});

// Einstellungen: Mehrwertsteuer, Wechselkurs, Rückstellung
router.put('/einstellungen', async (req, res) => {
  try { res.json(await fin.einstellungenSpeichern(req.user.id, req.body || {})); }
  catch (e) { fail(res, e); }
});

// Fixkosten und manuelle variable Kosten
router.get('/fixkosten', async (req, res) => { try { res.json(await fin.fixkostenListe(req.user.id)); } catch (e) { fail(res, e); } });
router.post('/fixkosten', async (req, res) => {
  try { res.json({ id: await fin.fixkostenNeu(req.user.id, req.body || {}) }); } catch (e) { fail(res, e); }
});
router.put('/fixkosten/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Nummer.' });
    if (!(await fin.fixkostenAendern(req.user.id, id, req.body || {}))) return res.status(404).json({ error: 'Posten nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete('/fixkosten/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Nummer.' });
    if (!(await fin.fixkostenLoeschen(req.user.id, id))) return res.status(404).json({ error: 'Posten nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Tatsächliche Anthropic-Rechnung eines Monats (leer löscht den Wert)
router.put('/anthropic', async (req, res) => {
  try {
    const m = String((req.body && req.body.month) || '');
    res.json({ month: m, anthropicChf: await fin.anthropicSetzen(req.user.id, m, req.body && req.body.betragChf) });
  } catch (e) { fail(res, e); }
});

router.__setStripe = s => { stripeOverride = s; fin.leereCache(); };
module.exports = router;
