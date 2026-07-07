const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Helper: check that requesting user owns the client
async function checkOwnership(req, res, clientId) {
  const { rows } = await pool.query(
    'SELECT id FROM clients WHERE id=$1 AND (advisor_id=$2 OR id=$3)',
    [clientId, req.user.id || null, req.user.clientId || null]
  );
  if (!rows[0]) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// GET /api/memory/:clientId
router.get('/:clientId', requireAuth, async (req, res) => {
  try {
    if (!await checkOwnership(req, res, req.params.clientId)) return;
    const { rows } = await pool.query(
      'SELECT memory_type, content, updated_at FROM company_memory WHERE client_id=$1 ORDER BY memory_type',
      [req.params.clientId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/:clientId/:type/history — Task 10
router.get('/:clientId/:type/history', requireAuth, async (req, res) => {
  try {
    if (!await checkOwnership(req, res, req.params.clientId)) return;
    const { rows } = await pool.query(
      'SELECT id, content, saved_at FROM company_memory_history WHERE client_id=$1 AND memory_type=$2 ORDER BY saved_at DESC LIMIT 20',
      [req.params.clientId, req.params.type]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memory/:clientId/:type/rollback/:historyId — Task 10
router.post('/:clientId/:type/rollback/:historyId', requireAuth, async (req, res) => {
  try {
    if (!await checkOwnership(req, res, req.params.clientId)) return;
    const { rows: histRows } = await pool.query(
      'SELECT * FROM company_memory_history WHERE id=$1 AND client_id=$2 AND memory_type=$3',
      [req.params.historyId, req.params.clientId, req.params.type]
    );
    if (!histRows[0]) return res.status(404).json({ error: 'Version not found' });

    // Archive current value before rollback
    const { rows: cur } = await pool.query(
      'SELECT content FROM company_memory WHERE client_id=$1 AND memory_type=$2',
      [req.params.clientId, req.params.type]
    );
    if (cur[0]) {
      await pool.query(
        'INSERT INTO company_memory_history (client_id, memory_type, content) VALUES ($1,$2,$3)',
        [req.params.clientId, req.params.type, cur[0].content]
      );
    }

    // Restore historical version
    await pool.query(
      `INSERT INTO company_memory (client_id, memory_type, content, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (client_id, memory_type) DO UPDATE
       SET content=EXCLUDED.content, updated_at=NOW()`,
      [req.params.clientId, req.params.type, histRows[0].content]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/memory/:clientId/:type — archives old version before saving
router.put('/:clientId/:type', requireAuth, async (req, res) => {
  try {
    if (!await checkOwnership(req, res, req.params.clientId)) return;
    const { content } = req.body;

    // Task 10: archive existing value before overwriting
    const { rows: existing } = await pool.query(
      'SELECT content FROM company_memory WHERE client_id=$1 AND memory_type=$2',
      [req.params.clientId, req.params.type]
    );
    if (existing[0] && existing[0].content !== content) {
      await pool.query(
        'INSERT INTO company_memory_history (client_id, memory_type, content) VALUES ($1,$2,$3)',
        [req.params.clientId, req.params.type, existing[0].content]
      );
    }

    const { rows } = await pool.query(
      `INSERT INTO company_memory (client_id, memory_type, content, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (client_id, memory_type) DO UPDATE
       SET content=EXCLUDED.content, updated_at=NOW()
       RETURNING *`,
      [req.params.clientId, req.params.type, content]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/memory/:clientId — called when client data is wiped
router.delete('/:clientId', requireAuth, async (req, res) => {
  try {
    if (!await checkOwnership(req, res, req.params.clientId)) return;
    const { rowCount } = await pool.query(
      'DELETE FROM company_memory WHERE client_id=$1',
      [req.params.clientId]
    );
    res.json({ deleted: rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
