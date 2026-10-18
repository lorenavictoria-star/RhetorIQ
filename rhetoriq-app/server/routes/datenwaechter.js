const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const dw = require('../lib/datenwaechter');
const store = require('../lib/datenwaechterStore');

const router = express.Router();
const MAX_TEXT = 100000;

const limit = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'dw:' + (req.user ? `${req.user.role}:${req.user.clientUserId || req.user.clientId || req.user.id}` : 'anon'),
  validate: false,
  message: { error: 'Zu viele Prüfungen in kurzer Zeit. Bitte warten Sie einen Moment.' }
});

const fail = (res, e) => {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  console.error('[datenwaechter]', e && e.code ? e.code : 'Fehler'); res.status(500).json({ error: 'Internal server error' });
};

// POST /api/datenwaechter/pruefen  { text }  -> { modus, funde: [{ typ, label, schwere, anzahl, vorschau }] }
// Die Vorschau ist maskiert. Es wird nichts gespeichert und nichts geloggt.
router.post('/pruefen', requireAuth, limit, async (req, res) => {
  try {
    const text = req.body && req.body.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'Es fehlt der Text.' });
    if (text.length > MAX_TEXT) return res.status(413).json({ error: 'Der Text ist zu lang für die Prüfung.' });
    const ein = await store.holeEinstellungen();
    if (ein.modus === 'aus') return res.json({ modus: 'aus', funde: [] });
    const funde = dw.erkenne(text, { typen: ein.typen });
    const gruppen = dw.gruppiere(funde).map((g) => {
      const erster = funde.find(f => f.typ === g.typ);
      return { typ: g.typ, label: g.label, schwere: g.schwere, anzahl: g.anzahl, vorschau: dw.maskiere(g.typ, text.slice(erster.start, erster.ende)) };
    });
    res.json({ modus: ein.modus, funde: gruppen });
  } catch (e) { fail(res, e); }
});

// GET /api/datenwaechter/einstellungen  (nur Beraterin)
router.get('/einstellungen', requireAdvisor, async (req, res) => {
  try {
    const e = await store.holeEinstellungen();
    res.json({ ...e, modi: store.MODI, alleTypen: dw.ALLE_TYPEN.map(t => ({ typ: t, label: dw.TYPEN[t].label, schwere: dw.TYPEN[t].schwere })) });
  } catch (e) { fail(res, e); }
});

// PUT /api/datenwaechter/einstellungen  { modus, typen }  (nur Beraterin)
router.put('/einstellungen', requireAdvisor, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await store.speichereEinstellungen({ modus: b.modus, typen: b.typen }));
  } catch (e) { fail(res, e); }
});

// GET /api/datenwaechter/auswertung  Anzahl Funde je Typ in den letzten 30 Tagen (ohne Inhalt, nur Beraterin)
router.get('/auswertung', requireAdvisor, async (req, res) => {
  try { res.json(await store.auswertung(30)); } catch (e) { fail(res, e); }
});

module.exports = router;
