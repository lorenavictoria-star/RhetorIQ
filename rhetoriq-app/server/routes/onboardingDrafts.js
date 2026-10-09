const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { ensureSchema } = require('../lib/schemaRedesign');
const { ALLE_MODULE, SEKTOR_NAME } = require('../lib/moduleCatalog');
const { safeFetchHtml, htmlToText } = require('../lib/safeFetch');
const { scanWebsite } = require('../lib/websiteScan');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { buildWorkshopDocs } = require('../lib/workshopDocs');
const { saveFile } = require('../lib/fileStore');
const crypto = require('crypto');
const { createClientRecord } = require('../lib/clientCreate');
const { toEnabledModules } = require('../lib/moduleCatalog');
const { queueEmail } = require('../lib/emailOutbox');
const { einladungMail, FRIST_TAGE } = require('../lib/onboardingMails');

// Onboarding-Entwürfe (Zwischenspeichern des Ablaufs vor dem Workshop).
//   POST   /api/onboarding-drafts            neuer Entwurf (optional aus inquiry_id)
//   GET    /api/onboarding-drafts            Liste
//   GET    /api/onboarding-drafts/:id        ein Entwurf
//   PUT    /api/onboarding-drafts/:id        Teilupdate
//   DELETE /api/onboarding-drafts/:id        löschen
const { TEXTARTEN } = require('../lib/moduleAccess');
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
  if (has('textarten')) {
    // null = alle Textarten; sonst Liste der erlaubten Textarten des Text Generators
    if (b.textarten === null) f.textarten = 'null';
    else if (Array.isArray(b.textarten)) f.textarten = JSON.stringify(b.textarten.filter(t => TEXTARTEN.includes(t)).filter((t, i, a) => a.indexOf(t) === i));
    else return { error: 'textarten muss eine Liste oder null sein.' };
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
  if (has('paket')) {
    const p = String(b.paket || '').toLowerCase();
    if (p && !['stimme', 'team', 'business', 'enterprise'].includes(p)) return { error: 'Unbekanntes Paket.' };
    f.paket = p;
  }
  if (has('themenplan')) f.themenplan = b.themenplan === true;
  if (has('groesse')) {
    const g = b.groesse && typeof b.groesse === 'object' ? b.groesse : {};
    f.groesse = JSON.stringify({ mitarbeitende: clip(g.mitarbeitende, 20), texte: clip(g.texte, 20), ferien: g.ferien === true });
  }
  if (has('status')) {
    if (!STATUS.includes(b.status)) return { error: 'Ungültiger Status.' };
    f.status = b.status;
  }
  return { fields: f };
}

const JSON_COLS = new Set(['module', 'textarten', 'vorschlaege', 'briefing', 'groesse']);

async function loadDraft(id) {
  const { rows } = await pool.query('SELECT * FROM onboarding_drafts WHERE id=$1', [id]);
  return rows[0] || null;
}

// Alle Routen mit :id: der Entwurf muss zur eingeloggten Beraterin gehören
router.use('/:id', requireAdvisor, async (req, res, next) => {
  try {
    await ensureSchema();
    if (await require('../lib/advisorScope').canAccessDraft(req, req.params.id)) return next();
    return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Internal server error' }); }
});

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
    const cols = ['inquiry_id', 'advisor_id', ...Object.keys(f)];
    const vals = [inquiryId, req.user.id, ...Object.values(f)];
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
       FROM onboarding_drafts WHERE advisor_id IS NULL OR advisor_id = $1 ORDER BY updated_at DESC LIMIT 200`, [req.user.id]);
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

// POST /api/onboarding-drafts/:id/scan: Webseite laden, KI-Briefing erstellen und im Entwurf speichern.
const scanLimit = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Zu viele Scans. Bitte später erneut versuchen.' }
});

router.post('/:id/scan', requireAdvisor, scanLimit, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const d = await loadDraft(id);
    if (!d) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    if (!d.webseite) return res.status(400).json({ error: 'Im Entwurf ist keine Webseite eingetragen.' });
    let page;
    try {
      page = await safeFetchHtml(d.webseite);
    } catch (e) {
      return res.status(422).json({ error: 'Die Webseite konnte nicht geladen werden: ' + e.message });
    }
    const text = htmlToText(page.html);
    if (text.length < 80) return res.status(422).json({ error: 'Auf der Webseite wurde zu wenig Text gefunden.' });
    let result;
    try {
      result = await scanWebsite({ text, firma: d.firma, sektor: d.sektor });
    } catch (e) {
      console.error('[scan] failed:', e.message);
      return res.status(502).json({ error: e.code === 'PARSE' ? e.message : 'Die KI ist gerade nicht erreichbar. Bitte später erneut versuchen.' });
    }
    const json = JSON.stringify(result);
    const { rows } = await pool.query(
      'UPDATE onboarding_drafts SET vorschlaege=$1::jsonb, briefing=$1::jsonb, updated_at=NOW() WHERE id=$2 RETURNING *',
      [json, id]);
    res.json({ ok: true, quelle: page.url, vorschlaege: result, draft: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/onboarding-drafts/:id/workshop-docs: erzeugt Briefing, Einführungsgespräch, Leitfaden und
// Erfassungsbogen (DOCX) und legt sie im Ordner 'workshop' des Entwurfs ab.
// Optional im Body: branche, zielgruppen (für Teil A des Erfassungsbogens).
router.post('/:id/workshop-docs', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const d = await loadDraft(id);
    if (!d) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    if (!d.firma) return res.status(400).json({ error: 'Im Entwurf fehlt die Firma.' });
    const b = d.briefing && typeof d.briefing === 'object' ? d.briefing : {};
    const body = req.body || {};
    const cfg = {
      firma: d.firma,
      kontakt: d.kontakt || '',
      sektor: d.sektor || '',
      datum: d.workshop_datum || '',
      module: Array.isArray(d.module) ? d.module : [],
      branche: clip(body.branche || b.branche, 160),
      zielgruppen: clip(body.zielgruppen || b.zielgruppen, 400),
      briefing: b
    };
    const docs = await buildWorkshopDocs(cfg);
    // Frühere Fassungen derselben Mappe ersetzen (nur solange es noch keinen Klienten gibt).
    await pool.query(`DELETE FROM client_files WHERE draft_id=$1 AND client_id IS NULL AND folder='workshop' AND name = ANY($2)`,
      [id, docs.map(x => x.name)]);
    const saved = [];
    for (const f of docs) {
      saved.push(await saveFile({ clientId: d.client_id || null, draftId: id, folder: 'workshop', name: f.name, mime: f.mime, buffer: f.buffer }));
    }
    res.json({ ok: true, files: saved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/onboarding-drafts/:id/finish: legt den Klienten an, setzt die Module, übernimmt die Dateien
// des Entwurfs, setzt Entwurf auf 'abgeschlossen' und die Anfrage auf 'klient' und sendet die Einladung
// mit Zugangslink (7 Tage gültig, Du- oder Sie-Form). Body: { privacyAcknowledged: true } ist Pflicht
// (wie bei POST /api/clients); optional clientType ('company'|'individual'), lastName.
router.post('/:id/finish', requireAdvisor, async (req, res) => {
  let claimed = null;
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const d = await loadDraft(id);
    if (!d) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    if (d.client_id || d.status === 'abgeschlossen') return res.status(409).json({ error: 'Dieser Entwurf ist bereits abgeschlossen.' });
    if (!(req.body && req.body.privacyAcknowledged === true)) return res.status(400).json({ error: 'Datenschutz-Bestätigung erforderlich' });
    const name = clip(d.firma || d.kontakt, 200);
    if (!name) return res.status(400).json({ error: 'Im Entwurf fehlt die Firma.' });
    if (!d.email || !EMAIL_RE.test(d.email)) return res.status(400).json({ error: 'Im Entwurf fehlt eine gültige E-Mail-Adresse.' });

    // Den Entwurf zuerst reservieren, damit ein doppelter Klick keinen zweiten Klienten anlegt.
    const claim = await pool.query(
      `UPDATE onboarding_drafts SET status='abgeschlossen', updated_at=NOW() WHERE id=$1 AND client_id IS NULL AND status <> 'abgeschlossen' RETURNING id`, [id]);
    if (!claim.rows.length) return res.status(409).json({ error: 'Dieser Entwurf ist bereits abgeschlossen.' });
    claimed = d.status;

    const kontaktTeile = String(d.kontakt || '').trim().split(/\s+/).filter(Boolean);
    const clientType = ['company', 'individual'].includes(req.body.clientType)
      ? req.body.clientType : (d.firma && d.firma !== d.kontakt ? 'company' : 'individual');
    const { row: client } = await createClientRecord({
      advisorId: req.user.id,
      name,
      industry: SEKTOR_NAME[d.sektor] || '',
      contact: clip(d.kontakt, 500),
      email: d.email,
      clientType,
      salutation: d.titel === 'Herr' ? 'Herr' : 'Frau',
      lastName: clip(req.body.lastName, 120) || (kontaktTeile.length ? kontaktTeile[kontaktTeile.length - 1] : ''),
      enabledModules: toEnabledModules(d.module),
      paket: d.paket
    });
    claimed = null;
    if (['stimme', 'team', 'business', 'enterprise'].includes(d.paket)) {
      await pool.query('UPDATE clients SET recommended_plan=$1 WHERE id=$2', [d.paket, client.id]).catch(e => console.error('[onboarding] Paket:', e.message));
    }
    {
      // Standard «alle». Nur das Bündel «Rede und Auftritt» ohne Text Generator schaltet allein die Textart Rede frei.
      const namen = Array.isArray(d.module) ? d.module : [];
      let arten = null;
      if (Array.isArray(d.textarten)) arten = d.textarten.filter(t => TEXTARTEN.includes(t));
      else if (namen.includes('Rede und Auftritt') && !namen.includes('Text Generator')) arten = ['speech'];
      if (arten) await pool.query('UPDATE clients SET enabled_textarten=$1 WHERE id=$2', [arten, client.id]).catch(e => console.error('[onboarding] Textarten:', e.message));
    }
    if (d.themenplan === true) await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [client.id]).catch(e => console.error('[onboarding] Themenplan:', e.message));
    await pool.query('UPDATE onboarding_drafts SET client_id=$1, updated_at=NOW() WHERE id=$2', [client.id, id]);
    await pool.query('UPDATE client_files SET client_id=$1 WHERE draft_id=$2 AND client_id IS NULL', [client.id, id]);
    if (d.inquiry_id) {
      await require('./inquiries').ensureTable();
      await pool.query(`UPDATE inquiries SET status='klient' WHERE id=$1`, [d.inquiry_id]);
    }

    // Einladung: der bestehende Ablauf (onboarding_tokens, /setup?t=...) mit 7 Tagen Gültigkeit.
    let inviteSent = false;
    const expires = new Date(Date.now() + FRIST_TAGE * 24 * 60 * 60 * 1000);
    try {
      const setupToken = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO onboarding_tokens (client_id, token, expires_at) VALUES ($1,$2,$3)', [client.id, setupToken, expires]);
      const link = `${process.env.APP_URL || 'https://rhetoriq.ch'}/setup?t=${setupToken}`;
      const mail = einladungMail({ kontakt: d.kontakt || d.firma, anrede: d.anrede === 'du' ? 'du' : 'sie', titel: d.titel, link });
      await queueEmail({ kind: 'client_invite', to: d.email, subject: mail.subject, text: mail.text, senderName: 'Lorena Lienhard' });
      inviteSent = true;
    } catch (e) {
      console.error('[onboarding-drafts] invite failed:', e.message);
    }
    const fresh = await loadDraft(id);
    res.status(201).json({
      ok: true,
      client: { id: client.id, name: client.name, email: client.email, slug: client.slug, enabled_modules: client.enabled_modules },
      inviteSent,
      inviteExpiresAt: inviteSent ? expires.toISOString() : null,
      draft: fresh
    });
  } catch (e) {
    console.error(e);
    if (claimed) {
      // Klient wurde nicht angelegt: Reservierung zurücknehmen.
      await pool.query(`UPDATE onboarding_drafts SET status=$1 WHERE id=$2 AND client_id IS NULL`, [claimed, parseId(req.params.id)]).catch(() => {});
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.loadDraft = loadDraft;
module.exports.parseId = parseId;
