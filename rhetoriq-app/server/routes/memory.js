const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/memory/:clientId
router.get('/:clientId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT memory_type, content, updated_at FROM company_memory WHERE client_id=$1 ORDER BY memory_type',
      [req.params.clientId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/memory/:clientId/:type
router.put('/:clientId/:type', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
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
