// Weitere Kalender (iCloud, Outlook) als Besetzt-Zeiten, nur lesen (nur Rolle advisor).
//  GET    /api/kalender/fremd         Liste ohne Links
//  POST   /api/kalender/fremd         { bezeichnung, url, farbe } hinzufügen (der Link wird sofort geprüft und verschlüsselt gespeichert)
//  PATCH  /api/kalender/fremd/:id     { bezeichnung?, farbe?, aktiv? }
//  DELETE /api/kalender/fremd/:id
//  POST   /api/kalender/fremd/abrufen jetzt lesen; leise: nur Quellen, die länger nicht gelesen wurden
// Die Links sind Geheimnisse: nie in Antworten, nie in Logs.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const secretBox = require('../lib/secretBox');
const KD = require('../lib/kalendersync/daten');
const F = require('../lib/kalendersync/fremd');
const { lies } = require('../lib/icsLesen');
const { bereinigeText } = require('../lib/tagesplan');

const router = express.Router();
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'kf_' + ((req.user && req.user.id) || 'x'), validate: { keyGeneratorIpFallback: false },
  message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
});
router.use(requireAdvisor, limiter);

const FARBE = /^#[0-9a-fA-F]{6}$/;
const MAX_KALENDER = 8;
function fail(res) { res.status(500).json({ error: 'Das hat nicht geklappt. Bitte versuche es gleich noch einmal.' }); }

router.get('/', async (req, res) => {
  try {
    res.json({ kalender: (await KD.fremdAlle(req.user.id)).map(KD.fremdOeffentlich), schluesselOk: secretBox.available() });
  } catch (e) { console.error('[kalender-fremd] Liste fehlgeschlagen'); fail(res); }
});

router.post('/', async (req, res) => {
  try {
    if (!secretBox.available()) return res.status(503).json({ error: 'Die Verschlüsselung ist noch nicht eingerichtet (SECRETS_ENCRYPTION_KEY). Der Link wird nicht gespeichert.' });
    const b = req.body || {};
    const bezeichnung = bereinigeText(b.bezeichnung, 60);
    if (!bezeichnung) return res.status(400).json({ error: 'Bitte gib dem Kalender eine Bezeichnung.' });
    const farbe = FARBE.test(b.farbe || '') ? b.farbe : '#8a8f98';
    if ((await KD.fremdAlle(req.user.id)).length >= MAX_KALENDER) return res.status(400).json({ error: `Du kannst höchstens ${MAX_KALENDER} weitere Kalender hinzufügen.` });
    let r, url;
    try {
      url = F.pruefeUrl(b.url).toString();
      r = await F.holeIcs(url);
    } catch (e) { return res.status(400).json({ error: F.freundlich(e) }); }
    const master = lies(r.text);
    const zeile = await KD.fremdAnlegen(req.user.id, bezeichnung, secretBox.encrypt(url), farbe);
    await KD.fremdErgebnis(zeile.id, { ok: true, ereignisse: JSON.stringify(master), etag: r.etag, lastModified: r.lastModified });
    res.status(201).json(KD.fremdOeffentlich(await KD.fremdHole(req.user.id, zeile.id)));
  } catch (e) { console.error('[kalender-fremd] Hinzufügen fehlgeschlagen'); fail(res); }
});

router.post('/abrufen', async (req, res) => {
  try {
    const r = await F.alleAktualisieren({ aid: req.user.id, mindestensAlt: !!(req.body && req.body.leise) });
    res.json({ ok: true, geaendert: r.geaendert, kalender: (await KD.fremdAlle(req.user.id)).map(KD.fremdOeffentlich) });
  } catch (e) { console.error('[kalender-fremd] Abruf fehlgeschlagen'); fail(res); }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige Nummer.' });
    const b = req.body || {};
    const felder = {};
    if (b.farbe !== undefined) { if (!FARBE.test(b.farbe)) return res.status(400).json({ error: 'Die Farbe ist ungültig.' }); felder.farbe = b.farbe; }
    if (b.aktiv !== undefined) felder.aktiv = b.aktiv === true;
    if (b.bezeichnung !== undefined) { const t = bereinigeText(b.bezeichnung, 60); if (!t) return res.status(400).json({ error: 'Bitte gib dem Kalender eine Bezeichnung.' }); felder.bezeichnung = t; }
    const z = await KD.fremdAendern(req.user.id, id, felder);
    if (!z) return res.status(404).json({ error: 'Kalender nicht gefunden.' });
    res.json(KD.fremdOeffentlich(z));
  } catch (e) { console.error('[kalender-fremd] Änderung fehlgeschlagen'); fail(res); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige Nummer.' });
    if (!(await KD.fremdLoeschen(req.user.id, id))) return res.status(404).json({ error: 'Kalender nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) { console.error('[kalender-fremd] Löschen fehlgeschlagen'); fail(res); }
});

module.exports = router;
