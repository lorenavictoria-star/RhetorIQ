// /api/webseiten: Seitenpaket-Generator für Restaurant-Webseiten.
//   GET  /seitentypen              Seitentypen, Seitensätze und Faktenfelder
//   POST /paket                    Lauf starten { clientId, einheitId, seitensatz?, seitentypen?, stichworte?, importUrls? } -> 202
//   GET  /paket/:id                Stand eines Pakets mit allen Seiten
//   GET  /paket/:id/export.docx    Word-Datei
//   GET  /pakete?clientId=         Liste der Pakete
//   POST /import/liste             Seiten einer bestehenden Webseite { url }
//   POST /import/seite             Text einer bestehenden Seite { url }
//   GET  /check?clientId=          Gesamtprüfung über die jüngsten fertigen Seiten
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { allowedClientId, canAccessClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const GS = require('../lib/gastroSeitentypen');
const EF = require('../lib/einheitFakten');
const WP = require('../lib/webseitenPaket');

const router = express.Router();
const MAX_LAUFENDE = 2;

// Opt-in-Modul «restaurants» wie in routes/einheiten.js
async function aktiv(clientId) {
  const { rows } = await pool.query('SELECT enabled_modules FROM clients WHERE id=$1', [clientId]);
  return !!(rows[0] && Array.isArray(rows[0].enabled_modules) && rows[0].enabled_modules.includes('restaurants'));
}
const NICHT_AKTIV = { error: 'Mehrere Restaurants oder Betriebe sind für diesen Kunden nicht freigeschaltet.' };
const fehler500 = (res, e) => { console.error(e); res.status(500).json({ error: 'Internal server error' }); };

// Zugangs-Token der Ansicht «readOnly» dürfen nichts erzeugen (auch nicht, wenn der Wächter in index.js fehlt)
const keinReadOnly = (req, res, next) => (req.user && req.user.readOnly === true ? res.status(403).json({ error: 'Nur Ansicht' }) : next());

async function paketLaden(req, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  await ensureSchema();
  const { rows } = await pool.query(
    'SELECT p.*, e.name AS einheit_name FROM webseiten_pakete p LEFT JOIN einheiten e ON e.id=p.einheit_id WHERE p.id=$1', [n]);
  if (!rows[0]) return null;
  return (await canAccessClient(req, rows[0].client_id)) ? rows[0] : null;
}

router.get('/seitentypen', requireAuth, (req, res) => {
  res.json({
    seitentypen: Object.values(GS.SEITENTYPEN).map(t => ({ key: t.key, label: t.label, gruppe: t.gruppe, laengeWoerter: t.laengeWoerter })),
    seitensaetze: GS.SEITENSAETZE,
    faktenFelder: EF.FAKTEN_FELDER
  });
});

router.post('/paket', requireAuth, requireRole('editor'), keinReadOnly, async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const clientId = await allowedClientId(req, b.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    if (!(await aktiv(clientId))) return res.status(403).json(NICHT_AKTIV);
    const einheitId = parseInt(b.einheitId, 10);
    if (!Number.isInteger(einheitId)) return res.status(400).json({ error: 'Bitte ein Restaurant wählen.' });
    const { rows: er } = await pool.query('SELECT * FROM einheiten WHERE id=$1', [einheitId]);
    if (!er[0] || Number(er[0].client_id) !== clientId) return res.status(403).json({ error: 'Kein Zugriff auf dieses Restaurant.' });

    const w = WP.waehleTypen(b);
    if (w.fehler) return res.status(400).json({ error: w.fehler });
    const imp = WP.importUrlsAus(b, w.typen);
    if (imp.fehler) return res.status(400).json({ error: imp.fehler });

    // Modul und Textart freigeschaltet, Tagesgrenze, Abo und Monatskontingent wie bei der normalen Erzeugung
    if (await require('../lib/moduleAccess').sperrt(req, res, 'text-gen', 'text-gen-website')) return;
    const cap = await require('../lib/costBrake').checkDailyCap(req.user, req.user.role === 'client' ? req.user.clientId : null);
    if (!cap.ok) return res.status(429).json({ error: cap.error, dailyCapReached: true, scope: cap.scope });
    const q = await WP.kontingentPruefen(clientId, req.user.role === 'advisor', w.typen.length);
    if (q) return res.status(q.status).json(q.body);

    const { rows: lauf } = await pool.query(`SELECT COUNT(*)::int AS n FROM webseiten_pakete WHERE client_id=$1 AND status='laeuft' AND updated_at > NOW() - INTERVAL '30 minutes'`, [clientId]);
    if (lauf[0].n >= MAX_LAUFENDE) return res.status(429).json({ error: 'Es laufen bereits zwei Seitenpakete. Bitte warten Sie, bis eines fertig ist.' });

    const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;
    const userRef = req.user.role === 'advisor' ? (req.user.name || 'Advisor') : (req.user.clientUserName || req.user.clientName || 'Klient');
    const wss = req.app.locals.wss;
    const notify = wss ? (note) => {
      try {
        if (advisorId) wss.toAdvisor(advisorId, note);
        wss.toClient(clientId, note);
      } catch { /* Hinweis ist nur ein Komfort */ }
    } : null;
    const r = await WP.starte({
      clientId, einheit: er[0], typen: w.typen, stichworte: WP.stichworteAus(b, w.typen), importUrls: imp.urls,
      advisorId, userRef, notify
    });
    res.status(202).json(r);
  } catch (e) { fehler500(res, e); }
});

router.get('/paket/:id/export.docx', requireAuth, async (req, res) => {
  try {
    const r = await paketLaden(req, req.params.id);
    if (!r) return res.status(403).json({ error: 'Kein Zugriff auf dieses Paket.' });
    const buf = await WP.docxFuer(WP.ausZeile(await WP.unterbrochenPruefen(r), true));
    const name = String(r.einheit_name || 'Restaurant').replace(/[^\wäöüÄÖÜéèà -]/g, '').trim().replace(/\s+/g, '_') || 'Restaurant';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Seitenpaket_${encodeURIComponent(name)}_${r.id}.docx"`
    });
    res.send(buf);
  } catch (e) { fehler500(res, e); }
});

router.get('/paket/:id', requireAuth, async (req, res) => {
  try {
    const r = await paketLaden(req, req.params.id);
    if (!r) return res.status(403).json({ error: 'Kein Zugriff auf dieses Paket.' });
    res.json(WP.ausZeile(await WP.unterbrochenPruefen(r), true));
  } catch (e) { fehler500(res, e); }
});

router.get('/pakete', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const clientId = await allowedClientId(req, req.query.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    if (!(await aktiv(clientId))) return res.json([]);
    const { rows } = await pool.query(
      `SELECT p.id, p.einheit_id, e.name AS einheit_name, p.status, p.gesamt, p.fertig, p.created_at, p.updated_at
       FROM webseiten_pakete p LEFT JOIN einheiten e ON e.id=p.einheit_id WHERE p.client_id=$1 ORDER BY p.created_at DESC, p.id DESC LIMIT 100`, [clientId]);
    const out = [];
    for (const r of rows) out.push(WP.ausZeile(await WP.unterbrochenPruefen(r), false));
    res.json(out);
  } catch (e) { fehler500(res, e); }
});

// Fehlermeldungen des Abrufs (lib/seiteImport.js) in verständliche Antworten übersetzen
function importFehler(res, e) {
  const code = e && e.code;
  if (code === 'ungueltig') return res.status(400).json({ error: e.message });
  if (code === 'verboten') return res.status(400).json({ error: 'Diese Adresse darf nicht abgerufen werden.' });
  console.error('[webseiten import]', e && e.message);
  return res.status(502).json({ error: 'Die Seite konnte nicht gelesen werden.' });
}

router.post('/import/liste', requireAuth, requireRole('editor'), keinReadOnly, async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'Bitte eine Adresse angeben.' });
    let liste;
    try { liste = await WP.abruf.sitemapSeiten(url); } catch (e) { return importFehler(res, e); }
    const seiten = (liste || []).map(s => {
      const typ = GS.seitentypFuerPfad(s.pfad);
      return { url: s.url, pfad: s.pfad, typ: typ || null, label: typ ? GS.SEITENTYPEN[typ].label : '' };
    });
    // Seiten mit erkanntem Typ zuerst, sonst in der Reihenfolge der Sitemap
    seiten.sort((a, b) => (a.typ ? 0 : 1) - (b.typ ? 0 : 1));
    res.json({ seiten });
  } catch (e) { fehler500(res, e); }
});

router.post('/import/seite', requireAuth, requireRole('editor'), keinReadOnly, async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'Bitte eine Adresse angeben.' });
    let seite;
    try { seite = await WP.abruf.seiteLesen(url); } catch (e) { return importFehler(res, e); }
    res.json(seite);
  } catch (e) { fehler500(res, e); }
});

router.get('/check', requireAuth, async (req, res) => {
  try {
    const clientId = await allowedClientId(req, req.query.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    if (!(await aktiv(clientId))) return res.status(403).json(NICHT_AKTIV);
    res.json(await WP.checkFuer(clientId));
  } catch (e) { fehler500(res, e); }
});

module.exports = router;
