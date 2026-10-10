// Tagesplan und Kalender der Beraterin (nur Rolle advisor), dazu der abonnierbare Kalender-Feed über einen geheimen Token.
//  GET    /api/tagesplan/plan?datum=        Plan eines Tages (Standard heute), live berechnet
//  POST   /api/tagesplan/plan/neu           Plan neu berechnen (gleiches Ergebnis wie GET, ab jetzt)
//  GET    /api/tagesplan/woche?montag=      Pläne und Blöcke einer Woche für die Kalenderansicht
//  GET    /api/tagesplan/ics?datum=         Kalenderdatei des Tages
//  GET    /api/tagesplan/naechste?minuten=  Nächste Aufgabe, optional was in die Zeit passt
//  GET/POST/PUT/DELETE /api/tagesplan/termine[/:id]
//  PUT/DELETE /api/tagesplan/position/:key  Aufgabe von Hand verschieben, wieder freigeben
//  POST   /api/tagesplan/dringlich          { reviewId, dringlich }
//  GET/PUT /api/tagesplan/einstellungen
//  GET/POST/DELETE /api/tagesplan/kalender  Abo-Link: Status, neu erzeugen, widerrufen
//  POST   /api/tagesplan/mail               Plan jetzt per Mail senden
//  GET    /api/tagesplan/feed/:token        öffentlich, nur mit gültigem Token
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const D = require('../lib/tagesplanDaten');
const T = require('../lib/tagesplan');
const Z = require('../lib/zeit');
const sync = require('../lib/kalendersync');

const router = express.Router();

const feedLimit = rateLimit({ windowMs: 60 * 1000, max: 30, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: true, legacyHeaders: false, message: 'Zu viele Anfragen.' });
router.get('/feed/:token', feedLimit, async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/\.ics$/i, '');
    const aid = await D.advisorZuToken(token);
    if (!aid) return res.status(404).type('text/plain').send('Nicht gefunden.');
    const { ics } = await D.icsFuerTag(aid, Z.heute(), { abo: true });
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="rhetoriq.ics"' }).send(ics);
  } catch (e) {
    console.error('[tagesplan] Feed fehlgeschlagen:', e.message);
    res.status(500).type('text/plain').send('Fehler.');
  }
});

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'tp_' + ((req.user && req.user.id) || 'x'), validate: { keyGeneratorIpFallback: false },
  message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
});
router.use(requireAdvisor, limiter);

function fail(res, e) {
  console.error('[tagesplan]', e && e.message);
  res.status(500).json({ error: 'Der Tagesplan konnte nicht geladen werden. Bitte versuche es gleich noch einmal.' });
}
const datumVon = (q) => (Z.istDatum(q) ? q : Z.heute());

router.get('/plan', async (req, res) => {
  try { res.json(await D.planFuer(req.user.id, datumVon(req.query.datum))); } catch (e) { fail(res, e); }
});
router.post('/plan/neu', async (req, res) => {
  try { res.json(await D.planFuer(req.user.id, datumVon(req.body && req.body.datum))); } catch (e) { fail(res, e); }
});
router.get('/woche', async (req, res) => {
  try {
    const montag = Z.montagVon(datumVon(req.query.montag));
    const tage = [];
    for (let i = 0; i < 7; i++) tage.push(await D.planFuer(req.user.id, Z.addTage(montag, i)));
    res.json({ montag, tage, heute: Z.heute(), typen: T.alleTypen(await D.einstellungen(req.user.id)) });
  } catch (e) { fail(res, e); }
});
router.get('/ics', async (req, res) => {
  try {
    const datum = datumVon(req.query.datum);
    const { ics } = await D.icsFuerTag(req.user.id, datum);
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="tagesplan.ics"' }).send(ics);
  } catch (e) { fail(res, e); }
});
router.get('/naechste', async (req, res) => {
  try {
    const plan = await D.planFuer(req.user.id, Z.heute());
    const min = parseInt(req.query.minuten, 10);
    res.json({ plan, ...T.naechste(plan, new Date(), Number.isInteger(min) && min >= 5 && min <= 720 ? min : null) });
  } catch (e) { fail(res, e); }
});

// ── Termine ──
async function pruefen(req) {
  const s = await D.einstellungen(req.user.id);
  return T.eintragPruefen(req.body, { settings: s, heute: Z.heute() });
}
const syncEreignis = (e, aid) => ({ advisorId: aid, id: e.id, uid: `rq-e${e.id}@rhetoriq.ch`, titel: e.titel, datum: e.datum, beginn: e.beginn, ende: e.ende, ganztaegig: e.ganztaegig, typ: e.typ, notiz: e.notiz,
  wiederholung: e.wiederholung, wochentage: e.wochentage, bis: e.bis });
const planGeaendert = (aid) => ({ advisorId: aid, uid: 'plan', art: 'plan' });
router.get('/termine', async (req, res) => {
  try { res.json({ termine: await D.eintraege(req.user.id), typen: T.alleTypen(await D.einstellungen(req.user.id)) }); } catch (e) { fail(res, e); }
});
router.post('/termine', async (req, res) => {
  try {
    const p = await pruefen(req);
    if (p.fehler) return res.status(400).json({ error: p.fehler });
    const e = await D.eintragAnlegen(req.user.id, p.eintrag);
    await sync.push(syncEreignis(e, req.user.id));
    res.status(201).json(e);
  } catch (e) { fail(res, e); }
});
router.put('/termine/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige Nummer.' });
    const p = await pruefen(req);
    if (p.fehler) return res.status(400).json({ error: p.fehler });
    const e = await D.eintragAendern(req.user.id, id, p.eintrag);
    if (!e) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    await sync.push(syncEreignis(e, req.user.id));
    res.json(e);
  } catch (e) { fail(res, e); }
});
router.delete('/termine/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige Nummer.' });
    const e = await D.eintragLoeschen(req.user.id, id);
    if (!e) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
    await sync.delete(syncEreignis(e, req.user.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Aufgaben verschieben ──
router.put('/position/:key', async (req, res) => {
  try {
    const key = String(req.params.key);
    const beginn = Z.zeitZuMin(req.body && req.body.beginn);
    if (!/^[a-z][A-Za-z0-9-]{0,40}$/.test(key) || !Z.istDatum(req.body && req.body.datum) || beginn == null || beginn >= 1440) return res.status(400).json({ error: 'Datum oder Uhrzeit ungültig.' });
    await D.positionSetzen(req.user.id, key, req.body.datum, beginn);
    await sync.push(planGeaendert(req.user.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete('/position/:key', async (req, res) => {
  try { await D.positionLoeschen(req.user.id, String(req.params.key)); await sync.push(planGeaendert(req.user.id)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
router.post('/dringlich', async (req, res) => {
  try {
    const id = parseInt(req.body && req.body.reviewId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige Freigabe.' });
    const ok = await D.dringlichSetzen(req.user.id, id, req.body.dringlich !== false);
    if (!ok) return res.status(404).json({ error: 'Freigabe nicht gefunden.' });
    await sync.push(planGeaendert(req.user.id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Einstellungen ──
router.get('/einstellungen', async (req, res) => {
  try { const s = await D.einstellungen(req.user.id); res.json({ einstellungen: s, typen: T.alleTypen(s) }); } catch (e) { fail(res, e); }
});
router.put('/einstellungen', async (req, res) => {
  try { const s = await D.einstellungenSpeichern(req.user.id, req.body); res.json({ einstellungen: s, typen: T.alleTypen(s) }); } catch (e) { fail(res, e); }
});

// ── Abo-Link ──
function feedUrl(req, token) {
  const basis = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const host = basis.replace(/^https?:\/\//, '');
  return { webcal: `webcal://${host}/api/tagesplan/feed/${token}.ics`, https: `${basis}/api/tagesplan/feed/${token}.ics` };
}
router.get('/kalender', async (req, res) => {
  try { res.json(await D.tokenStatus(req.user.id)); } catch (e) { fail(res, e); }
});
router.post('/kalender', async (req, res) => {
  try {
    const token = await D.tokenErzeugen(req.user.id);
    res.json({ aktiv: true, ...feedUrl(req, token), hinweis: 'Der Link wird nur jetzt angezeigt. Wer ihn kennt, sieht deinen Plan. Du kannst ihn jederzeit widerrufen.' });
  } catch (e) { fail(res, e); }
});
router.delete('/kalender', async (req, res) => {
  try { await D.tokenWiderrufen(req.user.id); res.json({ aktiv: false }); } catch (e) { fail(res, e); }
});

router.post('/mail', async (req, res) => {
  try {
    const r = await require('../jobs/tagesplan').runTagesplanJob({ erzwingen: true });
    if (r.status === 'leer') return res.status(409).json({ error: 'Heute steht nichts im Plan.' });
    if (r.status !== 'gesendet') return res.status(502).json({ error: 'Die Mail konnte nicht gesendet werden.' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
