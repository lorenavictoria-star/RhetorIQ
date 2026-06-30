const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

const router = express.Router();

// GET /api/clients
router.get('/', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, industry, contact, slug, token, created_at FROM clients WHERE advisor_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients
router.post('/', requireAdvisor, async (req, res) => {
  try {
    const { name, industry, contact } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36);
    const token = crypto.randomBytes(24).toString('hex');

    const { rows } = await pool.query(
      'INSERT INTO clients (advisor_id, name, industry, contact, slug, token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, industry || '', contact || '', slug, token]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
