// /api/bewertungen: Bewertungen beantworten (lib/bewertungen.js)
//   GET    /:clientId                         Einstellungen, Zähler, Bewertungen (?status=)
//   PUT    /:clientId/einstellungen           Modus (aus, entwurf, freigabe, auto), Vorlagen, Kontakthinweis
//   POST   /:clientId/neu                     Bewertung von Hand erfassen und Entwurf schreiben
//   POST   /:clientId/token                   neuen Webhook-Schlüssel erzeugen (wird einmal angezeigt)
//   POST   /:clientId/abholen                 Kanäle jetzt abfragen
//   PUT    /:clientId/:id                     Entwurf bearbeiten
//   POST   /:clientId/:id/neu-schreiben       neuer Entwurf, optional mit Hinweis
//   POST   /:clientId/:id/freigeben           veröffentlichen (Kanal verbunden) oder als freigegeben markieren
//   POST   /:clientId/:id/ueberspringen       ohne Antwort abschliessen
//   POST   /eingang/:clientId/:token          öffentlicher Webhook (Zapier, Make, Bewertungsdienste)
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole, isMainAccountOrAdvisor } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const B = require('../lib/bewertungen');

function build({ generate } = {}) {
  const router = express.Router();
  const nichtNurLesend = (req, res, next) => (req.user && req.user.readOnly ? res.status(403).json({ error: 'In dieser Ansicht lässt sich nichts ändern.' }) : next());
  const fehler = (res, e) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[bewertungen]', e && e.message);
    return res.status(500).json({ error: 'Internal server error' });
  };
  const idOk = (req, res, next) => { req.bid = parseInt(req.params.id, 10); return Number.isInteger(req.bid) ? next() : res.status(400).json({ error: 'Ungültige Nummer.' }); };

  // Öffentlicher Webhook zuerst: eigener Rate-Limit, Schlüssel im Pfad, kleine Nutzlast
  const hook = rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: req => ipKeyGenerator(req.ip), standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen.' } });
  router.post('/eingang/:clientId/:token', hook, express.json({ limit: '20kb' }), async (req, res) => {
    try {
      const clientId = parseInt(req.params.clientId, 10);
      if (!Number.isInteger(clientId) || !(await B.tokenGilt(clientId, req.params.token))) return res.status(401).json({ error: 'Schlüssel ungültig.' });
      const b = req.body || {};
      const r = await B.nimmAuf(clientId, { plattform: b.plattform || b.platform, externId: b.id || b.externId, autor: b.autor || b.author, sterne: b.sterne || b.rating, text: b.text || b.comment || b.review, einheitId: b.einheitId });
      if (r.neu) B.verarbeite(clientId, r.bewertung.id, { generate }).catch(e => console.error('[bewertungen]', e.message));
      res.status(r.neu ? 201 : 200).json({ ok: true, neu: r.neu });
    } catch (e) { return fehler(res, e); }
  });

  const gate = [requireAuth, requireRole('editor'), nichtNurLesend, ownClient('clientId')];

  router.get('/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      const [set, rows] = await Promise.all([B.einstellungen(clientId), B.liste(clientId, { status: req.query.status })]);
      const { rows: z } = await pool.query('SELECT status, COUNT(*)::int AS n FROM bewertungen WHERE client_id=$1 GROUP BY status', [clientId]);
      const zaehler = Object.fromEntries(z.map(r => [r.status, r.n]));
      const kanaele = {};
      for (const [k, v] of Object.entries(B.KANAELE)) kanaele[k] = { label: v.label, verbunden: await v.verbunden(clientId) };
      kanaele.rueckkanal = { label: 'Rückkanal', ...(await B.rueckkanalStatus(clientId)) };
      res.json({ einstellungen: set, standardVorlagen: B.STANDARD_VORLAGEN, zaehler, kanaele, bewertungen: rows });
    } catch (e) { return fehler(res, e); }
  });

  router.put('/:clientId/einstellungen', ...gate, async (req, res) => {
    try {
      const b = req.body || {};
      // Der Auto-Modus veröffentlicht ohne Prüfung durch einen Menschen: nur Beraterin oder Hauptzugang
      if (b.modus === 'auto' && !isMainAccountOrAdvisor(req.user)) return res.status(403).json({ error: 'Den Auto-Modus kann nur die Beraterin oder der Hauptzugang einschalten.' });
      res.json({ einstellungen: await B.speichereEinstellungen(Number(req.params.clientId), b) });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/neu', ...gate, async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      const r = await B.nimmAuf(clientId, req.body || {});
      if (!r.neu) return res.status(200).json({ neu: false });
      res.status(201).json({ neu: true, bewertung: await B.verarbeite(clientId, r.bewertung.id, { generate }) });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/token', ...gate, async (req, res) => {
    try { res.json({ token: await B.neuerToken(Number(req.params.clientId)), hinweis: 'Dieser Schlüssel wird nur jetzt angezeigt.' }); } catch (e) { return fehler(res, e); }
  });

  // Rückkanal einrichten (Zapier, Make, n8n): nur Beraterin oder Hauptzugang, der Signaturschlüssel wird einmal angezeigt
  router.put('/:clientId/rueckkanal', ...gate, async (req, res) => {
    try {
      if (!isMainAccountOrAdvisor(req.user)) return res.status(403).json({ error: 'Das darf nur die Beraterin oder der Hauptzugang.' });
      const r = await B.rueckkanalSetzen(Number(req.params.clientId), req.body && req.body.url);
      res.json({ ok: true, signaturSchluessel: r.secret, hinweis: 'Dieser Schlüssel wird nur jetzt angezeigt.' });
    } catch (e) { return fehler(res, e.status ? e : Object.assign(e, { status: 400 })); }
  });
  router.delete('/:clientId/rueckkanal', ...gate, async (req, res) => {
    try {
      if (!isMainAccountOrAdvisor(req.user)) return res.status(403).json({ error: 'Das darf nur die Beraterin oder der Hauptzugang.' });
      await B.rueckkanalEntfernen(Number(req.params.clientId)); res.json({ ok: true });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/abholen', ...gate, async (req, res) => {
    try { res.json(await B.abholenUndVerarbeiten(Number(req.params.clientId), { generate })); } catch (e) { return fehler(res, e); }
  });

  router.put('/:clientId/:id', ...gate, idOk, async (req, res) => {
    try {
      const text = String((req.body && req.body.entwurf) || '').trim().slice(0, 4000);
      if (!text) return res.status(400).json({ error: 'Der Entwurf ist leer.' });
      const { rows } = await pool.query(`UPDATE bewertungen SET entwurf=$3, antwort_final=$3 WHERE id=$1 AND client_id=$2 AND status NOT IN ('gepostet') RETURNING *`, [req.bid, Number(req.params.clientId), text]);
      if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden oder schon veröffentlicht.' });
      res.json({ bewertung: rows[0] });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/:id/neu-schreiben', ...gate, idOk, async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      const { rows } = await pool.query('SELECT * FROM bewertungen WHERE id=$1 AND client_id=$2', [req.bid, clientId]);
      if (!rows[0] || rows[0].status === 'gepostet') return res.status(404).json({ error: 'Nicht gefunden oder schon veröffentlicht.' });
      const e = await B.erzeugeEntwurf(clientId, rows[0], { hinweis: req.body && req.body.hinweis, generate });
      const u = await pool.query(`UPDATE bewertungen SET entwurf=$3, antwort_final=NULL, status='wartet', fehler=NULL WHERE id=$1 AND client_id=$2 RETURNING *`, [req.bid, clientId, e.entwurf]);
      res.json({ bewertung: u.rows[0] });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/:id/freigeben', ...gate, idOk, async (req, res) => {
    try {
      const r = await B.veroeffentliche(Number(req.params.clientId), req.bid, { text: req.body && req.body.text });
      if (!r) return res.status(404).json({ error: 'Nicht gefunden.' });
      res.json({ bewertung: r });
    } catch (e) { return fehler(res, e); }
  });

  router.post('/:clientId/:id/ueberspringen', ...gate, idOk, async (req, res) => {
    try {
      const { rows } = await pool.query(`UPDATE bewertungen SET status='uebersprungen' WHERE id=$1 AND client_id=$2 AND status <> 'gepostet' RETURNING *`, [req.bid, Number(req.params.clientId)]);
      if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden.' });
      res.json({ bewertung: rows[0] });
    } catch (e) { return fehler(res, e); }
  });

  return router;
}

const router = build();
module.exports = router;
module.exports.build = build;
