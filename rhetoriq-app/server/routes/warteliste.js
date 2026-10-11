// Warteliste «Platz sichern». Öffentlicher Teil ohne Anmeldung, Einstellungen und Verwaltung nur für die Beraterin.
//   GET  /api/warteliste/status                   öffentlich: aktiv ja/nein, echte Zähler (nur wenn erlaubt), Ticket gegen schnelle Bots
//   POST /api/warteliste                          öffentlich: Eintrag
//   GET/PUT /api/warteliste/admin/einstellungen   Beraterin
//   GET  /api/warteliste/admin/liste              Beraterin: Einträge nach Datum, dazu Zähler
//   PUT  /api/warteliste/admin/eintraege/:id/status   Beraterin: Status ändern
//   POST /api/warteliste/admin/eintraege/:id/einladen Beraterin: Mail «Zum Gespräch einladen»
//   DELETE /api/warteliste/admin/eintraege/:id    Beraterin: löschen
//   GET  /api/warteliste/admin/export.csv         Beraterin: CSV
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const B = require('../lib/buchung');
const W = require('../lib/warteliste');
const M = require('../lib/leadMails');
const MB = require('../lib/missbrauch');
const { queueEmail } = require('../lib/emailOutbox');
const { advisorEmails } = require('../lib/notify');
const { csvCell } = require('../lib/csvSafe');

const basisUrl = () => (process.env.BUCHUNG_BASIS_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const mailSicher = (m) => Promise.resolve().then(() => queueEmail(m)).catch(e => console.error('[warteliste] Mail fehlgeschlagen:', m.kind, e && e.message));

function build(opts = {}) {
  const { ipMax = 8, statusMax = 120, verwaltenMax = 300, emailMax = 3, jetzt = () => new Date(), minAlterMs = MB.MIN_ALTER_MS } = opts;
  const router = express.Router();
  const emailZaehler = MB.zaehler(emailMax, 3600000);
  const ipKey = (req) => ipKeyGenerator(req.ip);
  const mk = (max, windowMs) => rateLimit({ windowMs, max, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es später noch einmal.' } });
  const statusLimit = mk(statusMax, 5 * 60 * 1000);
  const eintragLimit = mk(ipMax, 60 * 60 * 1000);
  const verwaltenLimit = mk(verwaltenMax, 60 * 60 * 1000);
  router._zaehler = emailZaehler;
  const fehler500 = (res, e) => { console.error('[warteliste]', e && e.message); res.status(500).json({ error: 'Das hat leider nicht geklappt. Bitte versuchen Sie es noch einmal oder senden Sie mir eine Nachricht.' }); };

  // ── Öffentlich ──
  router.get('/status', statusLimit, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const aid = await W.advisorId();
      if (!aid) return res.json({ aktiv: false });
      const o = await W.oeffentlich(aid);
      if (o.aktiv) o.ticket = B.ticketNeu(jetzt());
      res.json(o);
    } catch (e) { fehler500(res, e); }
  });

  router.post('/', eintragLimit, async (req, res) => {
    try {
      if (!MB.vonUnsererSeite(req)) return res.status(401).json({ error: 'Nicht erlaubt.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      // Honeypot: dieses versteckte Feld füllen nur Bots aus. Sie erhalten eine scheinbar erfolgreiche Antwort.
      if (body.website2) return res.json({ ok: true });
      const alter = B.ticketAlter(body.ticket, jetzt());
      if (alter == null || alter > MB.MAX_ALTER_MS || alter < 0) return res.status(400).json({ error: 'Bitte laden Sie die Seite neu und versuchen Sie es noch einmal.' });
      if (alter < minAlterMs) return res.status(429).json({ error: 'Bitte nehmen Sie sich einen Moment Zeit und versuchen Sie es dann noch einmal.' });
      const aid = await W.advisorId();
      const s = aid ? await W.einstellungen(aid) : null;
      if (!s || !s.aktiv) return res.status(403).json({ error: 'Die Warteliste ist zurzeit geschlossen. Bitte senden Sie mir eine Nachricht.' });
      const p = W.pruefeEingabe(body);
      if (p.fehler) return res.status(400).json({ error: p.fehler, feld: p.feld });
      const w = p.werte;
      if (!emailZaehler.erlaubt('e:' + w.email, jetzt().getTime())) return res.status(429).json({ error: 'Es gab in kurzer Zeit zu viele Versuche. Bitte versuchen Sie es später noch einmal oder senden Sie mir eine Nachricht.' });
      const r = await W.eintragen(w, { jetzt: jetzt(), monat: s.fenster });
      if (r.schon) return res.json({ ok: true, schon: true, meldung: 'Sie stehen bereits auf der Liste. Ich melde mich persönlich bei Ihnen.' });
      if (!r.ok) return res.status(r.status || 500).json({ error: r.fehler });
      const e = r.eintrag;
      const b = M.wartelisteBestaetigung(e);
      mailSicher({ kind: 'warteliste_bestaetigung', to: e.email, subject: b.subject, text: b.text, senderName: 'Lorena Lienhard' });
      const h = M.wartelisteHinweis(e);
      for (const to of advisorEmails()) mailSicher({ kind: 'warteliste_hinweis', to, subject: h.subject, text: h.text, senderName: 'RhetorIQ' });
      res.json({ ok: true, schon: false });
    } catch (e) { fehler500(res, e); }
  });

  // ── Beraterin ──
  const idVon = (req) => { const id = parseInt(req.params.id, 10); return Number.isInteger(id) && id > 0 ? id : null; };
  router.get('/admin/einstellungen', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const s = await W.einstellungen(req.user.id);
      res.json({ einstellungen: s, zaehler: await W.zaehler(s), link: basisUrl() + '/platz' });
    } catch (e) { fehler500(res, e); }
  });
  router.put('/admin/einstellungen', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const s = await W.einstellungenSpeichern(req.user.id, req.body);
      res.json({ einstellungen: s, zaehler: await W.zaehler(s), link: basisUrl() + '/platz' });
    } catch (e) { fehler500(res, e); }
  });
  router.get('/admin/liste', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const s = await W.einstellungen(req.user.id);
      res.json({ eintraege: await W.liste(), zaehler: await W.zaehler(s) });
    } catch (e) { fehler500(res, e); }
  });
  router.put('/admin/eintraege/:id/status', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const id = idVon(req);
      if (!id) return res.status(400).json({ error: 'Ungültige Nummer.' });
      const status = req.body && req.body.status;
      if (!W.STATUS.includes(status)) return res.status(400).json({ error: 'Ungültiger Status.' });
      const s = await W.einstellungen(req.user.id);
      const e = await W.statusSetzen(id, status, s.fenster);
      if (!e) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
      res.json({ eintrag: e, zaehler: await W.zaehler(s) });
    } catch (e) { fehler500(res, e); }
  });
  router.post('/admin/eintraege/:id/einladen', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const id = idVon(req);
      if (!id) return res.status(400).json({ error: 'Ungültige Nummer.' });
      const alt = await W.nachId(id);
      if (!alt) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
      const m = M.wartelisteEinladung(alt, { terminUrl: basisUrl() + '/termin' });
      await queueEmail({ kind: 'warteliste_einladung', to: alt.email, subject: m.subject, text: m.text, senderName: 'Lorena Lienhard' });
      const s = await W.einstellungen(req.user.id);
      const e = await W.statusSetzen(id, 'eingeladen', s.fenster);
      res.json({ ok: true, eintrag: e, zaehler: await W.zaehler(s) });
    } catch (e) { fehler500(res, e); }
  });
  router.delete('/admin/eintraege/:id', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const id = idVon(req);
      if (!id) return res.status(400).json({ error: 'Ungültige Nummer.' });
      if (!(await W.loeschen(id))) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
      const s = await W.einstellungen(req.user.id);
      res.json({ ok: true, zaehler: await W.zaehler(s) });
    } catch (e) { fehler500(res, e); }
  });
  router.get('/admin/export.csv', requireAdvisor, verwaltenLimit, async (req, res) => {
    try {
      const l = await W.liste();
      const kopf = ['Datum', 'Name', 'E-Mail', 'Unternehmen', 'Branche', 'Anliegen', 'Status', 'Monat', 'Einwilligung'];
      const datum = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; } };
      const zeilen = [kopf.map(csvCell).join(';')].concat(l.map(e => [datum(e.created_at), e.name, e.email, e.unternehmen, e.branche, e.anliegen, e.status, e.monat, e.einwilligung ? 'ja' : 'nein'].map(csvCell).join(';')));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="warteliste.csv"');
      res.send('﻿' + zeilen.join('\r\n') + '\r\n');
    } catch (e) { fehler500(res, e); }
  });

  return router;
}

const router = build();
router.build = build;
module.exports = router;
