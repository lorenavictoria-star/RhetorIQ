const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/module-examples?moduleKey=xxx  (omit moduleKey for all)
router.get('/', requireAdvisor, async (req, res) => {
  try {
    const { moduleKey } = req.query;
    let q = 'SELECT * FROM module_examples WHERE advisor_id=$1';
    const params = [req.user.id];
    if (moduleKey) { q += ' AND module_key=$2'; params.push(moduleKey); }
    q += ' ORDER BY module_key, rating DESC, created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/module-examples
router.post('/', requireAdvisor, async (req, res) => {
  try {
    const { module_key, label, industry_tag, input_text, output_text, rating = 3 } = req.body;
    if (!module_key || !input_text || !output_text)
      return res.status(400).json({ error: 'module_key, input_text and output_text required' });
    const { rows } = await pool.query(
      'INSERT INTO module_examples (advisor_id,module_key,label,industry_tag,input_text,output_text,rating) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, module_key, label || null, industry_tag || null, input_text, output_text, rating]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        `INSERT INTO module_examples (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated)
         VALUES ($1,$2,$3,$4,$5,$6,3,true)`,
        [req.user.id, a.module, client.name, industryTag, inputText, a.result]
      );
      imported++;
    }

    await pool.query(
      'UPDATE clients SET training_imported_at=NOW() WHERE id=$1',
      [clientId]
    );
    res.json({ imported, clientName: client.name });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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
         (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated)
         VALUES ($1,$2,$3,$4,$5,$6,3,true)`,
        [req.user.id, a.module, client.name, industryTag, inputText, a.result]
      );
      imported++;
    }

    // Import company memory entries (brand voice, key facts, etc.) as context-module examples
    for (const m of memRows) {
      if (!m.content?.trim()) continue;
      await pool.query(
        `INSERT INTO module_examples
         (advisor_id, module_key, label, industry_tag, input_text, output_text, rating, auto_generated)
         VALUES ($1,'_context',$2,$3,$4,$5,4,true)`,
        [req.user.id, client.name, industryTag,
          `[${m.memory_type}] ${client.name}`, m.content]
      );
      imported++;
    }

    res.json({ imported, clientName: client.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/module-examples/:id/rating
router.put('/:id/rating', requireAdvisor, async (req, res) => {
  try {
    const { rating } = req.body;
    await pool.query(
      'UPDATE module_examples SET rating=$1 WHERE id=$2 AND advisor_id=$3',
      [rating, req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/module-examples/:id
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await pool.query('DELETE FROM module_examples WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
