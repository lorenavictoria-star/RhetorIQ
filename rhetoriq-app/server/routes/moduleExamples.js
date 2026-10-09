const express = require('express');
const { pool } = require('../db');
const rateLimit = require('express-rate-limit').rateLimit;
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const beispielLib = require('../lib/beispielAuswahl');

const router = express.Router();

// GET /api/module-examples/summary — count per module_key
router.get('/summary', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT module_key, COUNT(*)::int as total,
              SUM(CASE WHEN auto_generated THEN 1 ELSE 0 END)::int as auto_count
       FROM module_examples WHERE advisor_id=$1
       GROUP BY module_key ORDER BY total DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/module-examples?moduleKey=xxx  (omit moduleKey for all)
router.get('/', requireAdvisor, async (req, res) => {
  try {
    const { moduleKey } = req.query;
    // Nur Vorlagen der Beraterin ohne Klientenbezug; Beispiele einzelner Klienten stehen unter /client/:clientId
    let q = 'SELECT * FROM module_examples WHERE advisor_id=$1 AND source_client_id IS NULL';
    const params = [req.user.id];
    const tm = moduleKey && /^text-gen-([a-z]+)$/.exec(moduleKey);
    if (tm) { q += ' AND module_key=$2 AND tile=$3'; params.push('text-gen', tm[1]); }
    else if (moduleKey) { q += ' AND module_key=$2'; params.push(moduleKey); }
    q += ' ORDER BY module_key, rating DESC, created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/module-examples
router.post('/', requireAdvisor, async (req, res) => {
  try {
    let { module_key, label, industry_tag, input_text, output_text, rating = 3 } = req.body;
    // Textarten des Text-Generators (text-gen-email) gehören zum Modul text-gen, die Textart wird getrennt gespeichert
    let tile = TILES.includes(req.body.tile) ? req.body.tile : null;
    const tm = /^text-gen-([a-z]+)$/.exec(String(module_key || ''));
    if (tm) { module_key = 'text-gen'; if (TILES.includes(tm[1])) tile = tm[1]; }
    if (!module_key || !input_text || !output_text)
      return res.status(400).json({ error: 'module_key, input_text and output_text required' });
    // Stammt die Vorlage aus den Texten eines Klienten (source_client_id), gilt sie nur für diesen Klienten,
    // ausser is_cross_client_shareable ist ausdrücklich true. Ohne Klientenbezug ist es eine Vorlage der Beraterin.
    let sourceClientId = null;
    if (req.body.source_client_id != null) {
      sourceClientId = parseInt(req.body.source_client_id, 10);
      const { rows: own } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [sourceClientId, req.user.id]);
      if (!own[0]) return res.status(404).json({ error: 'Client not found' });
    }
    const labelClean = beispielLib.bezeichnung(label);
    if (sourceClientId) {
      const voll = await beispielLib.platzSchaffen(pool, { advisorId: req.user.id, clientId: sourceClientId, module: module_key, label: labelClean });
      if (voll) return res.status(409).json({ error: beispielLib.grenzeText(voll) });
    }
    const shareable = sourceClientId ? req.body.is_cross_client_shareable === true : req.body.is_cross_client_shareable !== false;
    const { rows } = await pool.query(
      "INSERT INTO module_examples (advisor_id,module_key,label,industry_tag,input_text,output_text,rating,source_client_id,is_cross_client_shareable,origin,tile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10) RETURNING *",
      [req.user.id, module_key, labelClean, industry_tag || null, input_text, output_text, rating, sourceClientId, shareable, tile]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/module-examples/auto-import/:clientId — silent background import (idempotent)
router.post('/auto-import/:clientId', requireAdvisor, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId);
    const { rows: cRows } = await pool.query(
      'SELECT id, name, industry, training_imported_at FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!cRows[0]) return res.status(404).json({ error: 'Client not found' });
    // Already imported — skip silently
    if (cRows[0].training_imported_at) return res.json({ skipped: true });

    const client = cRows[0];
    const industryTag = client.industry?.toLowerCase().trim() || null;

    const { rows: analyses } = await pool.query(
      `SELECT module, input_data, result FROM analyses
       WHERE client_id=$1 AND advisor_id=$2 AND result IS NOT NULL AND result != ''`,
      [clientId, req.user.id]
    );

    let imported = 0;
    for (const a of analyses) {
      const inputText = Object.entries(a.input_data || {})
        .filter(([, v]) => v && typeof v === 'string' && v.trim().length > 2)
        .map(([k, v]) => `${k}: ${v.trim()}`).join('\n');
      if (!inputText || !a.result) continue;
      await pool.query(
        `INSERT INTO module_examples (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable)
         VALUES ($1,$2,$3,$4,$5,$6,3,true,$7,false)`,
        [req.user.id, a.module, client.name, industryTag, inputText, a.result, clientId]
      );
      imported++;
    }

    await pool.query(
      'UPDATE clients SET training_imported_at=NOW() WHERE id=$1',
      [clientId]
    );
    res.json({ imported, clientName: client.name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/module-examples/import-client — bulk import analyses from a client
router.post('/import-client', requireAdvisor, async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    // Verify client belongs to this advisor
    const { rows: cRows } = await pool.query(
      'SELECT id, name, industry FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!cRows[0]) return res.status(404).json({ error: 'Client not found' });
    const client = cRows[0];
    const industryTag = client.industry?.toLowerCase().trim() || null;

    // Fetch all analyses for this client
    const { rows: analyses } = await pool.query(
      `SELECT module, module_label, input_data, result FROM analyses
       WHERE client_id=$1 AND advisor_id=$2 AND result IS NOT NULL AND result != ''
       ORDER BY created_at DESC`,
      [clientId, req.user.id]
    );

    if (!analyses.length) return res.json({ imported: 0 });

    // Also fetch company memory as context entries
    const { rows: memRows } = await pool.query(
      `SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND content IS NOT NULL`,
      [clientId]
    );

    let imported = 0;

    // Import analyses as structural training examples
    for (const a of analyses) {
      const inputText = Object.entries(a.input_data || {})
        .filter(([, v]) => v && typeof v === 'string' && v.trim().length > 2)
        .map(([k, v]) => `${k}: ${v.trim()}`)
        .join('\n');
      if (!inputText || !a.result) continue;

      await pool.query(
        `INSERT INTO module_examples
         (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable)
         VALUES ($1,$2,$3,$4,$5,$6,3,true,$7,false)`,
        [req.user.id, a.module, client.name, industryTag, inputText, a.result, client.id]
      );
      imported++;
    }

    // Import company memory entries (brand voice, key facts, etc.) as context-module examples
    for (const m of memRows) {
      if (!m.content?.trim()) continue;
      await pool.query(
        `INSERT INTO module_examples
         (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable)
         VALUES ($1,'_context',$2,$3,$4,$5,4,true,$6,false)`,
        [req.user.id, client.name, industryTag,
          `[${m.memory_type}] ${client.name}`, m.content, client.id]
      );
      imported++;
    }

    res.json({ imported, clientName: client.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Beispiele pro Klient: Anzeige, eigene Beispiele der Klienten, Onboarding-Vorschläge ───────────────────────────
const TILES = ['linkedin', 'newsletter', 'email', 'speech', 'press', 'website', 'custom', 'brief'];
const MIN_LAENGE = beispielLib.MIN_LAENGE_BEISPIEL;
const MAX_LAENGE = 12000;
const MAX_PRO_MODUL = beispielLib.MAX_PRO_MODUL;
const MODULKEY = /^[a-z0-9][a-z0-9-]{1,39}$/;

// Schreibrate der Klienten begrenzen (Nutzer-Token, nicht nur IP)
const schreibLimit = rateLimit({
  windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'bsp:' + ((req.user && (req.user.clientUserId || req.user.clientId || req.user.id)) || 'x'),
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es in einigen Minuten erneut.' }
});

// Klienten dürfen nur lesen und schreiben, wenn sie mindestens Editor sind und nicht in der Ansicht des Klienten stecken
function klientenRegeln(req, res, next) {
  if (req.user && req.user.readOnly === true) return res.status(403).json({ error: 'Nur Ansicht' });
  next();
}

// Beraterin des Klienten (aus der Datenbank, nie aus der Anfrage)
async function beraterinVon(clientId) {
  const { rows } = await pool.query('SELECT advisor_id FROM clients WHERE id=$1', [clientId]);
  return rows[0] ? rows[0].advisor_id : null;
}

const pubRow = (r, klientId) => {
  const a = beispielLib.zurAuswahl(r, klientId);
  const herkunft = r.origin === 'thumbs' ? 'daumen' : r.origin === 'client' ? 'klient' : r.origin === 'onboarding' ? 'onboarding' : (r.source_client_id == null ? 'vorlage' : 'manuell');
  return {
    id: r.id, module_key: r.module_key, tile: r.tile || null, label: r.label || null, herkunft, rating: r.rating,
    status: r.status || 'active', created_at: r.created_at, input_text: r.input_text, output_text: r.output_text,
    source_client_id: r.source_client_id, zurAuswahl: a.ja, grund: a.grund
  };
};

// GET /api/module-examples/vorschlaege — offene Vorschläge aus dem Onboarding (Beraterin)
router.get('/vorschlaege', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, c.name AS client_name FROM module_examples e LEFT JOIN clients c ON c.id=e.source_client_id
       WHERE e.advisor_id=$1 AND e.status='proposed' ORDER BY e.created_at DESC`, [req.user.id]);
    res.json(rows.map(r => ({ ...pubRow(r, r.source_client_id), client_name: r.client_name })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/module-examples/client/:clientId — Beispiele eines Klienten.
// Beraterin: alle Beispiele des Klienten samt freigegebenen Vorlagen und Kennzeichnung, was zur Auswahl steht.
// Klient (ab Rolle Editor): nur die eigenen, selbst hochgeladenen oder per Daumen hoch entstandenen Beispiele.
router.get('/client/:clientId', requireAuth, requireRole('editor'), klientenRegeln, ownClient('clientId'), async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const advisorId = await beraterinVon(clientId);
    const isAdvisor = req.user.role === 'advisor';
    const params = [advisorId, clientId];
    let sql = `SELECT * FROM module_examples WHERE advisor_id=$1 AND auto_generated=false AND (source_client_id=$2`;
    if (isAdvisor) sql += ` OR (source_client_id IS NULL AND is_cross_client_shareable IS TRUE)`;
    sql += ')';
    if (!isAdvisor) sql += ` AND origin IN ('client','thumbs') AND COALESCE(status,'active')='active'`;
    if (req.query.moduleKey) { sql += ' AND module_key=$3'; params.push(String(req.query.moduleKey)); }
    sql += ' ORDER BY module_key, rating DESC, created_at DESC';
    const { rows } = await pool.query(sql, params);
    const autoCount = isAdvisor
      ? (await pool.query('SELECT COUNT(*)::int AS n FROM module_examples WHERE advisor_id=$1 AND auto_generated=true AND source_client_id=$2', [advisorId, clientId])).rows[0].n
      : 0;
    res.json({ examples: rows.map(r => pubRow(r, clientId)), autoCount, max: MAX_PRO_MODUL, maxBezeichnung: beispielLib.MAX_PRO_BEZEICHNUNG, maxLaengeBezeichnung: beispielLib.MAX_BEZEICHNUNG, minLaenge: MIN_LAENGE, maxLaenge: MAX_LAENGE });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/module-examples/client/:clientId — eigenes Beispiel hinzufügen (Klient ab Editor oder Beraterin)
router.post('/client/:clientId', requireAuth, requireRole('editor'), klientenRegeln, ownClient('clientId'), schreibLimit, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const moduleKey = String(req.body.module_key || '').trim();
    const text = String(req.body.text || '').replace(/\r\n/g, '\n').trim();
    const tile = TILES.includes(req.body.tile) ? req.body.tile : null;
    const title = String(req.body.title || '').trim();
    if (!MODULKEY.test(moduleKey)) return res.status(400).json({ error: 'Bitte wählen Sie ein Modul.' });
    if (text.length < MIN_LAENGE) return res.status(400).json({ error: `Der Text ist zu kurz. Ein Beispiel braucht mindestens ${MIN_LAENGE} Zeichen.` });
    if (text.length > MAX_LAENGE) return res.status(400).json({ error: `Der Text ist zu lang (höchstens ${MAX_LAENGE} Zeichen).` });
    const advisorId = await beraterinVon(clientId);
    if (!advisorId) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    const { rows: dup } = await pool.query(
      `SELECT id FROM module_examples WHERE advisor_id=$1 AND source_client_id=$2 AND module_key=$3 AND output_text=$4`, [advisorId, clientId, moduleKey, text]);
    if (dup[0]) return res.status(200).json({ id: dup[0].id, duplicate: true });
    const label = beispielLib.bezeichnung(title);
    // Handbeispiele werden nie automatisch gelöscht; nur Daumen-hoch-Beispiele weichen bei voller Grenze
    const voll = await beispielLib.platzSchaffen(pool, { advisorId, clientId, module: moduleKey, label });
    if (voll) return res.status(409).json({ error: beispielLib.grenzeText(voll) });
    const { rows } = await pool.query(
      `INSERT INTO module_examples (advisor_id, module_key, tile, label, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable, origin, status)
       VALUES ($1,$2,$3,$4,$5,$6,3,false,$7,false,'client','active') RETURNING *`,
      [advisorId, moduleKey, tile, label, label || 'Eigenes Beispiel', text, clientId]);
    res.status(201).json(pubRow(rows[0], clientId));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/module-examples/client/:clientId/:id — Klienten löschen nur eigene Beispiele (Herkunft Klient oder Daumen), die Beraterin alle des Klienten
router.delete('/client/:clientId/:id', requireAuth, requireRole('editor'), klientenRegeln, ownClient('clientId'), async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const advisorId = await beraterinVon(clientId);
    const extra = req.user.role === 'advisor' ? '' : ` AND origin IN ('client','thumbs')`;
    const r = await pool.query(`DELETE FROM module_examples WHERE id=$1 AND advisor_id=$2 AND source_client_id=$3${extra}`, [req.params.id, advisorId, clientId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/module-examples/client/:clientId/:id/label — Bezeichnung ändern (Klienten nur bei eigenen Beispielen)
router.put('/client/:clientId/:id/label', requireAuth, requireRole('editor'), klientenRegeln, ownClient('clientId'), schreibLimit, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const advisorId = await beraterinVon(clientId);
    const extra = req.user.role === 'advisor' ? '' : ` AND origin IN ('client','thumbs')`;
    const { rows } = await pool.query(`SELECT * FROM module_examples WHERE id=$1 AND advisor_id=$2 AND source_client_id=$3${extra}`, [req.params.id, advisorId, clientId]);
    if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden.' });
    const label = beispielLib.bezeichnung(req.body.label);
    const voll = label ? await beispielLib.platzSchaffen(pool, { advisorId, clientId, module: rows[0].module_key, label, ausser: rows[0].id }) : null;
    if (voll) return res.status(409).json({ error: beispielLib.grenzeText(voll) });
    const u = await pool.query('UPDATE module_examples SET label=$2 WHERE id=$1 RETURNING *', [rows[0].id, label]);
    res.json(pubRow(u.rows[0], clientId));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/module-examples/:id/confirm— Onboarding-Vorschlag bestätigen (optional mit geändertem Modul und geänderter Textart)
router.post('/:id/confirm', requireAdvisor, async (req, res) => {
  try {
    const moduleKey = req.body.module_key ? String(req.body.module_key).trim() : null;
    if (moduleKey && !MODULKEY.test(moduleKey)) return res.status(400).json({ error: 'Ungültiges Modul.' });
    const tile = req.body.tile === undefined ? undefined : (TILES.includes(req.body.tile) ? req.body.tile : null);
    const { rows: cur } = await pool.query(`SELECT * FROM module_examples WHERE id=$1 AND advisor_id=$2 AND status='proposed'`, [req.params.id, req.user.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    const { rows } = await pool.query(`UPDATE module_examples SET status='active', module_key=$2, tile=$3 WHERE id=$1 RETURNING *`,
      [cur[0].id, moduleKey || cur[0].module_key, tile === undefined ? cur[0].tile : tile]);
    if (!rows[0]) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    res.json(pubRow(rows[0], rows[0].source_client_id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/module-examples/:id/rating
router.put('/:id/rating', requireAdvisor, async (req, res) => {
  try {
    const rating = parseInt(req.body.rating, 10);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'rating must be 1 to 5' });
    await pool.query(
      'UPDATE module_examples SET rating=$1 WHERE id=$2 AND advisor_id=$3',
      [rating, req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/module-examples/:id/label — Bezeichnung einer Vorlage der Beraterin ohne Klientenbezug ändern
router.put('/:id/label', requireAdvisor, async (req, res) => {
  try {
    const r = await pool.query('UPDATE module_examples SET label=$3 WHERE id=$1 AND advisor_id=$2 AND source_client_id IS NULL RETURNING id',
      [req.params.id, req.user.id, beispielLib.bezeichnung(req.body.label)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/module-examples/:id
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await pool.query('DELETE FROM module_examples WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
