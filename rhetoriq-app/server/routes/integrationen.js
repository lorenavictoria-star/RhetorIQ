// /api/integrationen: Brevo, Mailchimp, WordPress verbinden und Entwürfe ablegen (lib/integrationen.js).
//   GET    /status/:clientId                        welche Anbieter verbunden sind (nie Zugangsdaten)
//   PUT    /:anbieter/:clientId                     verbinden (Rolle admin): prüft, speichert verschlüsselt
//   DELETE /:anbieter/:clientId                     trennen
//   GET    /:anbieter/listen/:clientId              Listen (Brevo, Mailchimp)
//   POST   /:anbieter/direkt/:clientId              Entwurf ablegen { text, kampagne?, merken? }
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const I = require('../lib/integrationen');
const secretBox = require('../lib/secretBox');
const { scrubText } = require('../lib/scrub');

const router = express.Router();

function nichtNurLesend(req, res, next) {
  if (req.user && req.user.readOnly) return res.status(403).json({ error: 'In dieser Ansicht lässt sich nichts ändern.' });
  next();
}
function fehler(res, e) {
  if (e instanceof I.IntFehler) {
    const status = e.code === 'limit' ? 429 : (e.code === 'server' || e.code === 'netz') ? 502 : e.code === 'nichtVerbunden' ? 409 : 400;
    return res.status(status).json({ error: e.message, anbieter: e.code, ...(e.code === 'nichtVerbunden' ? { nichtVerbunden: true } : {}) });
  }
  console.error('[integration]', scrubText(e && e.message));
  return res.status(500).json({ error: 'Internal server error' });
}
function anbieterOk(req, res, next) {
  const a = I.anbieter(req.params.anbieter);
  if (!a) return res.status(404).json({ error: 'Unbekannter Dienst.' });
  req.dienst = a;
  next();
}

router.get('/status/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const v = await I.verbundene(clientId);
    const out = { konfiguriert: secretBox.available(), anbieter: {} };
    for (const n of Object.keys(I.ANBIETER)) out.anbieter[n] = { label: I.ANBIETER[n].label, art: I.ANBIETER[n].art, verbunden: v.includes(n) };
    res.json(out);
  } catch (e) { return fehler(res, e); }
});

router.put('/:anbieter/:clientId', requireAuth, requireRole('admin'), nichtNurLesend, ownClient('clientId'), anbieterOk, async (req, res) => {
  try {
    if (!secretBox.available()) return res.status(503).json({ nichtEingerichtet: true, error: 'Die sichere Ablage für Zugangsdaten ist noch nicht eingerichtet. Bitte melden Sie sich bei Lorena.' });
    const a = req.dienst, b = req.body || {};
    const daten = {};
    for (const f of a.felder) daten[f] = typeof b[f] === 'string' ? b[f].trim() : '';
    if (!a.pruefeFormat(daten)) return res.status(400).json({ error: a.formatText });
    await a.pruefe(daten);
    await I.speichere(Number(req.params.clientId), req.params.anbieter, daten);
    res.json({ ok: true, verbunden: true });
  } catch (e) { return fehler(res, e); }
});

router.delete('/:anbieter/:clientId', requireAuth, requireRole('admin'), nichtNurLesend, ownClient('clientId'), anbieterOk, async (req, res) => {
  try {
    await I.loesche(Number(req.params.clientId), req.params.anbieter);
    res.json({ ok: true, verbunden: false });
  } catch (e) { return fehler(res, e); }
});

router.get('/:anbieter/listen/:clientId', requireAuth, requireRole('editor'), ownClient('clientId'), anbieterOk, async (req, res) => {
  try {
    const daten = await I.lade(Number(req.params.clientId), req.params.anbieter);
    if (!daten) return res.status(409).json({ nichtVerbunden: true, error: `${req.dienst.label} ist noch nicht verbunden.` });
    if (!req.dienst.listen) return res.json({ listen: [] });
    res.json({ listen: await req.dienst.listen(daten) });
  } catch (e) { return fehler(res, e); }
});

router.post('/:anbieter/direkt/:clientId', requireAuth, requireRole('editor'), nichtNurLesend, ownClient('clientId'), anbieterOk, async (req, res) => {
  try {
    const clientId = Number(req.params.clientId), name = req.params.anbieter, a = req.dienst;
    const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Es gibt noch keinen Text.' });
    if (text.length > 200000) return res.status(400).json({ error: 'Der Text ist zu lang.' });
    if (!(await I.lade(clientId, name))) return res.status(409).json({ nichtVerbunden: true, error: `${a.label} ist noch nicht verbunden. Die Admin-Person Ihres Unternehmens verbindet es unter «Abo verwalten».` });
    let kampagne = null;
    if (a.listeNoetig) {
      kampagne = req.body && req.body.kampagne;
      if (kampagne && !I.kampagneGueltig(kampagne)) return res.status(400).json({ error: 'Bitte wählen Sie eine Liste und tragen Sie eine gültige Absenderadresse ein.' });
      if (!kampagne) kampagne = await I.voreinstellung(clientId, name);
      if (!kampagne) return res.status(409).json({ voreinstellungFehlt: true, error: 'Bitte wählen Sie einmal die Liste und den Absender für den Entwurf.' });
      if (req.body && req.body.merken === true) await I.merkeVoreinstellung(clientId, name, kampagne);
    }
    res.json(await I.entwurfAnlegen(clientId, name, { text, kampagne }));
  } catch (e) { return fehler(res, e); }
});

module.exports = router;
