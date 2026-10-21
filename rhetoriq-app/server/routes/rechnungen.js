// /api/rechnungen: Rechnung per Überweisung mit QR-Einzahlungsschein (lib/rechnung.js).
//   GET/PUT /einstellungen                              Absenderangaben und IBAN (nur Beraterin)
//   GET     /client/:clientId                           Rechnungen eines Klienten (Beraterin, Admin-Person des Klienten)
//   GET     /client/:clientId/vorschlag                 Vorbelegung für eine neue Rechnung (nur Beraterin)
//   POST    /client/:clientId                           Rechnung erstellen (nur Beraterin)
//   GET     /client/:clientId/:id/pdf                   PDF mit QR-Einzahlungsschein
//   POST    /client/:clientId/:id/senden | bezahlt | storno   (nur Beraterin)
const express = require('express');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const R = require('../lib/rechnung');
const RA = require('../lib/rechnungAuto');

const router = express.Router();

function fehler(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.einstellungenFehlen ? { einstellungenFehlen: true } : {}) });
  if (e && e.name === 'ValidationError') return res.status(400).json({ error: 'Die Angaben für den Einzahlungsschein sind ungültig: ' + String(e.message).slice(0, 200) });
  console.error('[rechnung]', e && e.message);
  return res.status(500).json({ error: 'Internal server error' });
}
const oeffentlich = (r) => ({
  id: r.id, nummer: r.nummer, posten: r.posten, laufzeit: r.laufzeit, beschreibung: r.beschreibung, betragRappen: r.betrag_rappen,
  status: r.status, ausgestelltAm: r.ausgestellt_am, faelligAm: r.faellig_am, gesendetAm: r.gesendet_am, bezahltAm: r.bezahlt_am,
  ueberfaellig: r.status === 'offen' && r.faellig_am && new Date(r.faellig_am) < new Date()
});
async function laden(req) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM rechnungen WHERE id=$1 AND client_id=$2', [parseInt(req.params.id, 10), Number(req.params.clientId)]);
  return rows[0] || null;
}

router.get('/einstellungen', requireAdvisor, async (req, res) => {
  try { const e = await R.holeEinstellungen(); res.json({ einstellungen: e, vollstaendig: R.pruefeEinstellungen(e).length === 0 }); }
  catch (e) { return fehler(res, e); }
});
router.put('/einstellungen', requireAdvisor, async (req, res) => {
  try {
    const f = R.pruefeEinstellungen(req.body || {});
    if (f.length) return res.status(400).json({ error: f[0], fehler: f });
    res.json({ einstellungen: await R.speichereEinstellungen(req.body), vollstaendig: true });
  } catch (e) { return fehler(res, e); }
});

router.get('/posten', requireAdvisor, (req, res) => {
  res.json({ posten: Object.entries(R.POSTEN).map(([key, p]) => ({ key, label: p.label, rappen: p.cents, laufzeit: !!p.laufzeit, freitext: !!p.freitext, jahrRappen: p.laufzeit ? R.betragFuer(key, 'jahr') : null })) });
});

router.get('/client/:clientId', requireAuth, requireRole('admin'), ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT * FROM rechnungen WHERE client_id=$1 ORDER BY ausgestellt_am DESC, id DESC', [Number(req.params.clientId)]);
    const { rows: c } = await pool.query('SELECT bezahlt_bis FROM clients WHERE id=$1', [Number(req.params.clientId)]);
    res.json({ rechnungen: rows.map(oeffentlich), bezahltBis: c[0] ? c[0].bezahlt_bis : null });
  } catch (e) { return fehler(res, e); }
});

router.get('/client/:clientId/vorschlag', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT name, email, address FROM clients WHERE id=$1', [Number(req.params.clientId)]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ empfaenger: { name: rows[0].name || '', ...R.adresseAusFreitext(rows[0].address) }, email: rows[0].email || '' });
  } catch (e) { return fehler(res, e); }
});

router.post('/client/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await R.legeAn({ clientId: Number(req.params.clientId), posten: b.posten, laufzeit: b.laufzeit, betragRappen: Number.isInteger(b.betragRappen) ? b.betragRappen : undefined, beschreibung: b.beschreibung, empfaenger: b.empfaenger || {}, bemerkung: b.bemerkung });
    res.json({ rechnung: oeffentlich(r) });
  } catch (e) { return fehler(res, e); }
});

router.get('/client/:clientId/:id/pdf', requireAuth, requireRole('admin'), ownClient('clientId'), async (req, res) => {
  try {
    const r = await laden(req);
    if (!r) return res.status(404).json({ error: 'Rechnung nicht gefunden.' });
    const e = await R.holeEinstellungen();
    const pdf = await R.pdfErzeugen(r, e);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Rechnung_${r.nummer}.pdf"`);
    res.send(pdf);
  } catch (e) { return fehler(res, e); }
});

router.post('/client/:clientId/:id/senden', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const r = await laden(req);
    if (!r) return res.status(404).json({ error: 'Rechnung nicht gefunden.' });
    if (r.status === 'storniert') return res.status(409).json({ error: 'Eine stornierte Rechnung wird nicht gesendet.' });
    const an = await R.sendeRechnung(r, { an: req.body && req.body.an });
    res.json({ ok: true, an });
  } catch (e) { return fehler(res, e); }
});

router.post('/client/:clientId/:id/bezahlt', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const r = await laden(req);
    if (!r) return res.status(404).json({ error: 'Rechnung nicht gefunden.' });
    const neu = await R.alsBezahltMarkieren(r.id, { bezahltAm: req.body && req.body.bezahltAm });
    const { rows: c } = await pool.query('SELECT bezahlt_bis, subscription_status FROM clients WHERE id=$1', [r.client_id]);
    res.json({ rechnung: oeffentlich(neu), bezahltBis: c[0] ? c[0].bezahlt_bis : null, status: c[0] ? c[0].subscription_status : null });
  } catch (e) { return fehler(res, e); }
});

router.post('/client/:clientId/:id/storno', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const r = await laden(req);
    if (!r) return res.status(404).json({ error: 'Rechnung nicht gefunden.' });
    if (r.status === 'bezahlt') return res.status(409).json({ error: 'Eine bezahlte Rechnung lässt sich nicht stornieren.' });
    await pool.query(`UPDATE rechnungen SET status='storniert' WHERE id=$1`, [r.id]);
    res.json({ ok: true });
  } catch (e) { return fehler(res, e); }
});

// Automatische Rechnungen je Klient
router.get('/client/:clientId/auto', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { res.json({ auto: await RA.holeAbo(Number(req.params.clientId)) }); } catch (e) { return fehler(res, e); }
});
router.put('/client/:clientId/auto', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ auto: await RA.setzeAbo(Number(req.params.clientId), { aktiv: b.aktiv === true, posten: b.posten, laufzeit: b.laufzeit, empfaenger: b.empfaenger, bemerkung: b.bemerkung, vorlaufTage: b.vorlaufTage }) });
  } catch (e) { return fehler(res, e); }
});

// Zahlungsabgleich: Bankdatei (camt.054 oder camt.053) als Text im Feld «xml»
router.post('/zahlungen', requireAdvisor, async (req, res) => {
  try {
    const xml = req.body && typeof req.body.xml === 'string' ? req.body.xml : '';
    res.json(await RA.abgleichen(xml));
  } catch (e) { return fehler(res, e); }
});

module.exports = router;
