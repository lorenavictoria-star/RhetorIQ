const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { ensureSchema } = require('../lib/schemaRedesign');
const { ALLE_MODULE, SEKTOR_NAME } = require('../lib/moduleCatalog');

// Onboarding-Entwürfe (Zwischenspeichern des Ablaufs vor dem Workshop).
//   POST   /api/onboarding-drafts            neuer Entwurf (optional aus inquiry_id)
//   GET    /api/onboarding-drafts            Liste
//   GET    /api/onboarding-drafts/:id        ein Entwurf
//   PUT    /api/onboarding-drafts/:id        Teilupdate
//   DELETE /api/onboarding-drafts/:id        löschen
const router = express.Router();

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUS = ['workshop_offen', 'bereit', 'abgeschlossen'];
const MAX_JSON = 300 * 1024;

function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanModule(arr) {
  if (!Array.isArray(arr)) return null;
  return [...new Set(arr.map(x => clip(x, 60)).filter(x => ALLE_MODULE.includes(x)))];
}

function cleanObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = JSON.stringify(v);
  return s.length <= MAX_JSON ? s : null;
}

// Prüft die übergebenen Felder und liefert { fields, error }.
function validateFields(body, { partial }) {
  const f = {};
  const b = body || {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (has('firma')) f.firma = clip(b.firma, 160);
  if (has('kontakt')) f.kontakt = clip(b.kontakt, 120);
  if (has('email')) {
    const e = clip(b.email, 200).toLowerCase();
    if (e && !EMAIL_RE.test(e)) return { error: 'Ungültige E-Mail-Adresse.' };
    f.email = e;
  }
  if (has('webseite')) f.webseite = clip(b.webseite, 300);
  if (has('sektor')) {
    const s = clip(b.sektor, 30);
    if (s && !SEKTOR_NAME[s]) return { error: 'Unbekannter Sektor.' };
    f.sektor = s;
  }
  if (has('anrede')) {
    if (!['du', 'sie'].includes(b.anrede)) return { error: "Anrede muss 'du' oder 'sie' sein." };
    f.anrede = b.anrede;
  }
  if (has('titel')) f.titel = ['Frau', 'Herr'].includes(b.titel) ? b.titel : '';
  if (has('workshop_datum')) f.workshop_datum = clip(b.workshop_datum, 80);
  if (has('schritt')) {
    const n = parseInt(b.schritt, 10);
    if (!Number.isInteger(n) || n < 0 || n > 20) return { error: 'Ungültiger Schritt.' };
    f.schritt = n;
  }
  if (has('module')) {
    const m = cleanModule(b.module);
    if (!m) return { error: 'module muss eine Liste sein.' };
    f.module = JSON.stringify(m);
  }
  if (has('vorschlaege')) {
    const o = cleanObject(b.vorschlaege);
    if (!o) return { error: 'vorschlaege muss ein Objekt (max. 300 KB) sein.' };
    f.vorschlaege = o;
  }
  if (has('briefing')) {
    const o = cleanObject(b.briefing);
    if (!o) return { error: 'briefing muss ein Objekt (max. 300 KB) sein.' };
    f.briefing = o;
  }
  if (has('status')) {
    if (!STATUS.includes(b.status)) return { error: 'Ungültiger Status.' };
    f.status = b.status;
  }
  return { fields: f };
}

const JSON_COLS = new Set(['module', 'vorschlaege', 'briefing']);

async function loadDraft(id) {
  const { rows } = await pool.query('SELECT * FROM onboarding_drafts WHERE id=$1', [id]);
  return rows[0] || null;
}

router.post('/', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const v = validateFields(req.body, { partial: false });
    if (v.error) return res.status(400).json({ error: v.error });
    const f = v.fields;
    let inquiryId = null;
    if (req.body && req.body.inquiry_id != null) {
      inquiryId = parseId(req.body.inquiry_id);
      if (!inquiryId) return res.status(400).json({ error: 'Ungültige inquiry_id.' });
      const inq = await require('./inquiries').ensureTable().then(() =>
        pool.query('SELECT * FROM inquiries WHERE id=$1', [inquiryId]));
      const q = inq.rows[0];
      if (!q) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
      // Vorbefüllung aus der Anfrage; ausdrücklich übergebene Felder haben Vorrang.
      if (f.kontakt === undefined) f.kontakt = clip(q.name, 120);
      if (f.email === undefined) f.email = clip(q.email, 200).toLowerCase();
      if (f.firma === undefined) f.firma = clip(q.company || q.name, 160);
      if (f.anrede === undefined && ['du', 'sie'].includes(q.anrede)) f.anrede = q.anrede;
      if (f.workshop_datum === undefined && q.workshop_date) f.workshop_datum = clip(q.workshop_date, 80);
    }
    if (!f.firma && !f.kontakt) return res.status(400).json({ error: 'Firma oder Ansprechperson erforderlich.' });
    const cols = ['inquiry_id', ...Object.keys(f)];
    const vals = [inquiryId, ...Object.values(f)];
    const ph = cols.map((c, i) => JSON_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO onboarding_drafts (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
    if (inquiryId) {
      await pool.query(`UPDATE inquiries SET status='workshop_offen' WHERE id=$1 AND status NOT IN ('klient')`, [inquiryId]);
    }
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT id, inquiry_id, firma, kontakt, email, webseite, sektor, anrede, titel, workshop_datum,
              schritt, module, status, client_id, created_at, updated_at
       FROM onboarding_drafts ORDER BY updated_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const d = await loadDraft(id);
    if (!d) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    res.json(d);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const v = validateFields(req.body, { partial: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const keys = Object.keys(v.fields);
    if (!keys.length) return res.status(400).json({ error: 'Keine Felder übergeben.' });
    const sets = keys.map((c, i) => `${c}=${JSON_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`}`);
    const { rows } = await pool.query(
      `UPDATE onboarding_drafts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
      [...keys.map(k => v.fields[k]), id]);
    if (!rows.length) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const d = await loadDraft(id);
    if (!d) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    await pool.query('DELETE FROM client_files WHERE draft_id=$1 AND client_id IS NULL', [id]);
    await pool.query('DELETE FROM onboarding_drafts WHERE id=$1', [id]);
    // Wurde die Anfrage wegen dieses Entwurfs auf workshop_offen gesetzt, geht sie zurück auf vorab_gesendet bzw. neu.
    if (d.inquiry_id && d.status !== 'abgeschlossen') {
      const other = await pool.query('SELECT 1 FROM onboarding_drafts WHERE inquiry_id=$1 LIMIT 1', [d.inquiry_id]);
      if (!other.rows.length) {
        await pool.query(
          `UPDATE inquiries SET status = CASE WHEN vorab_sent_at IS NOT NULL THEN 'vorab_gesendet' ELSE 'neu' END
           WHERE id=$1 AND status='workshop_offen'`, [d.inquiry_id]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.loadDraft = loadDraft;
module.exports.parseId = parseId;
