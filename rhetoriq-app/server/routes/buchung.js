// Terminbuchung. Öffentlicher Teil ohne Anmeldung, Einstellungen und Liste nur für die Beraterin.
//   GET  /api/buchung/slots                       freie Zeiten, nach Tagen gruppiert (nur Zeitpunkte), dazu ein Ticket gegen schnelle Bots
//   POST /api/buchung                             bucht (oder verschiebt, wenn ein Token mitgeschickt wird)
//   POST /api/buchung/info    { token }           Angaben zum eigenen Termin für die Seite zum Absagen und Verschieben
//   POST /api/buchung/absagen { token }           sagt den Termin ab
//   GET/PUT /api/buchung/admin/einstellungen      Beraterin: Einstellungen
//   GET  /api/buchung/admin/liste                 Beraterin: kommende Buchungen
//   POST /api/buchung/admin/liste/:id/absagen     Beraterin: Termin absagen
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const B = require('../lib/buchung');
const Z = require('../lib/zeit');
const BD = require('../lib/buchungDaten');

const ALLOWED_ORIGINS = ['https://rhetoriq.ch', 'https://www.rhetoriq.ch'];
const MIN_ALTER_MS = 4000;          // Menschen brauchen mehr als 4 Sekunden von der Anzeige der Zeiten bis zum Absenden
const MAX_ALTER_MS = 6 * 3600000;   // ältere Seiten bitte neu laden

// Kleine Zählung im Speicher (je Adresse und Fenster). Reicht für einen einzelnen Server.
function zaehler(max, fensterMs) {
  const m = new Map();
  return {
    erlaubt(key, jetzt = Date.now()) {
      if (m.size > 5000) for (const [k, v] of m) if (!v.length || jetzt - v[v.length - 1] > fensterMs) m.delete(k);
      const liste = (m.get(key) || []).filter(t => jetzt - t < fensterMs);
      if (liste.length >= max) { m.set(key, liste); return false; }
      liste.push(jetzt); m.set(key, liste); return true;
    },
    leeren() { m.clear(); }
  };
}

function erlaubteHerkunft() {
  const l = ALLOWED_ORIGINS.slice();
  try { if (process.env.APP_URL) l.push(new URL(process.env.APP_URL).origin); } catch {}
  return l;
}
function vonUnsererSeite(req) {
  const origin = String(req.headers.origin || req.headers.referer || '');
  return erlaubteHerkunft().some(o => origin === o || origin.startsWith(o + '/'));
}

function build(opts = {}) {
  const { ipMax = 10, slotMax = 120, verwaltenMax = 30, emailMax = 5, jetzt = () => new Date(), minAlterMs = MIN_ALTER_MS } = opts;
  const router = express.Router();
  const emailZaehler = zaehler(emailMax, 3600000);
  const ipKey = (req) => ipKeyGenerator(req.ip);
  const mk = (max, windowMs) => rateLimit({ windowMs, max, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es später noch einmal.' } });
  const slotLimit = mk(slotMax, 5 * 60 * 1000);
  const bucheLimit = mk(ipMax, 60 * 60 * 1000);
  const verwaltenLimit = mk(verwaltenMax, 60 * 60 * 1000);
  router._zaehler = emailZaehler;

  const fehler500 = (res, e) => { console.error('[buchung]', e && e.message); res.status(500).json({ error: 'Das hat leider nicht geklappt. Bitte versuchen Sie es noch einmal oder senden Sie mir eine Nachricht.' }); };

  // ── Öffentlich ──
  router.get('/slots', slotLimit, async (req, res) => {
    try {
      const aid = await BD.advisorId();
      if (!aid) return res.json({ aktiv: false, tage: [] });
      const d = await BD.freieOeffentlich(aid, jetzt());
      res.set('Cache-Control', 'no-store');
      res.json({ aktiv: d.aktiv, zeitzone: Z.TZ, dauer: d.dauer, tage: d.tage, ticket: B.ticketNeu(jetzt()) });
    } catch (e) { fehler500(res, e); }
  });

  router.post('/', bucheLimit, async (req, res) => {
    try {
      if (!vonUnsererSeite(req)) return res.status(401).json({ error: 'Nicht erlaubt.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      // Honeypot: dieses versteckte Feld füllen nur Bots aus. Sie erhalten eine scheinbar erfolgreiche Antwort.
      if (body.website2) return res.json({ ok: true });
      const alter = B.ticketAlter(body.ticket, jetzt());
      if (alter == null || alter > MAX_ALTER_MS || alter < 0) return res.status(400).json({ error: 'Bitte laden Sie die Seite neu und versuchen Sie es noch einmal.' });
      if (alter < minAlterMs) return res.status(429).json({ error: 'Bitte nehmen Sie sich einen Moment Zeit und versuchen Sie es dann noch einmal.' });
      const aid = await BD.advisorId();
      if (!aid) return res.status(404).json({ error: 'Die Terminbuchung ist zurzeit nicht verfügbar.' });
      const s = await BD.einstellungen(aid);
      if (!s.aktiv) return res.status(403).json({ error: 'Die Terminbuchung ist zurzeit nicht verfügbar. Bitte senden Sie mir eine Nachricht.' });
      const verschieben = typeof body.token === 'string' && body.token.length > 0;
      if (verschieben && !B.tokenForm(body.token)) return res.status(404).json({ error: 'Dieser Link ist nicht mehr gültig. Bitte wählen Sie einen neuen Termin.' });
      const p = B.pruefeEingabe(body, { mitPersonalien: !verschieben });
      if (p.fehler) return res.status(400).json({ error: p.fehler, feld: p.feld });
      const w = p.werte;
      if (!w.start) return res.status(400).json({ error: 'Bitte wählen Sie eine Zeit aus.', feld: 'start' });
      const key = verschieben ? 't:' + B.tokenHash(w.token).slice(0, 24) : 'e:' + w.email;
      if (!emailZaehler.erlaubt(key, jetzt().getTime())) return res.status(429).json({ error: 'Es gab in kurzer Zeit zu viele Versuche. Bitte versuchen Sie es später noch einmal oder senden Sie mir eine Nachricht.' });
      const r = await BD.buchen(aid, w, { jetzt: jetzt() });
      if (!r.ok) return res.status(r.status).json({ error: r.fehler });
      const b = r.buchung;
      res.json({ ok: true, verschoben: !!r.alt, datum: b.datum, label: Z.datumMitJahr(b.datum), zeit: Z.hhmm(b.beginn), ende: Z.hhmm(b.ende), dauer: b.ende - b.beginn });
    } catch (e) { fehler500(res, e); }
  });

  router.post('/info', verwaltenLimit, async (req, res) => {
    try {
      const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
      const b = await BD.nachToken(token);
      if (!b || !['gebucht', 'abgesagt'].includes(b.status)) return res.status(404).json({ error: 'Dieser Link ist nicht gültig.' });
      const vorbei = b.start_at.getTime() <= jetzt().getTime();
      res.json({ status: b.status, datum: b.datum, label: Z.datumMitJahr(b.datum), zeit: Z.hhmm(b.beginn), ende: Z.hhmm(b.ende), dauer: b.ende - b.beginn, aenderbar: b.status === 'gebucht' && !vorbei });
    } catch (e) { fehler500(res, e); }
  });

  router.post('/absagen', verwaltenLimit, async (req, res) => {
    try {
      if (!vonUnsererSeite(req)) return res.status(401).json({ error: 'Nicht erlaubt.' });
      const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
      const b = await BD.nachToken(token);
      if (!b || !['gebucht', 'abgesagt'].includes(b.status)) return res.status(404).json({ error: 'Dieser Link ist nicht gültig.' });
      const r = await BD.absagen(b.advisor_id, b.id, { wer: 'interessent', jetzt: jetzt() });
      if (!r.ok) return res.status(r.status || 500).json({ error: r.fehler });
      res.json({ ok: true, schon: !!r.schon });
    } catch (e) { fehler500(res, e); }
  });

  // ── Beraterin ──
  router.get('/admin/einstellungen', requireAdvisor, async (req, res) => {
    try {
      const s = await BD.einstellungen(req.user.id);
      res.json({ einstellungen: s, link: BD.neuUrl(), kommende: await BD.kommende(req.user.id, jetzt()) });
    } catch (e) { fehler500(res, e); }
  });
  router.put('/admin/einstellungen', requireAdvisor, async (req, res) => {
    try { res.json({ einstellungen: await BD.einstellungenSpeichern(req.user.id, req.body), link: BD.neuUrl() }); } catch (e) { fehler500(res, e); }
  });
  router.get('/admin/liste', requireAdvisor, async (req, res) => {
    try { res.json({ kommende: await BD.kommende(req.user.id, jetzt()) }); } catch (e) { fehler500(res, e); }
  });
  router.post('/admin/liste/:id/absagen', requireAdvisor, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Nummer.' });
      const b = await BD.nachId(id);
      if (!b || b.advisor_id !== req.user.id) return res.status(404).json({ error: 'Buchung nicht gefunden.' });
      const r = await BD.absagen(req.user.id, id, { wer: 'beraterin', jetzt: jetzt() });
      if (!r.ok) return res.status(r.status || 500).json({ error: r.fehler });
      res.json({ ok: true });
    } catch (e) { fehler500(res, e); }
  });

  return router;
}

const router = build();
router.build = build;
module.exports = router;
