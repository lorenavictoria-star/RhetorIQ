const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/people?clientId=X
router.get('/', requireAuth, async (req, res) => {
  try {
    const clientId = req.query.clientId || (req.user.role === 'client' ? req.user.clientId : null);
    if (!clientId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT p.*,
        COALESCE(json_agg(pp.*) FILTER (WHERE pp.id IS NOT NULL), '[]') as profiles
       FROM people p
       LEFT JOIN people_profiles pp ON pp.person_id = p.id
       WHERE p.client_id = $1
       GROUP BY p.id
       ORDER BY p.name`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/people
router.post('/', requireAuth, async (req, res) => {
  try {
    const { clientId, name, role, department, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { rows } = await pool.query(
      `INSERT INTO people (client_id, name, role, department, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [clientId, name, role || null, department || null, notes || null]
    );
    res.json({ ...rows[0], profiles: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/people/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, role, department, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE people SET name=$1, role=$2, department=$3, notes=$4
       WHERE id=$5 RETURNING *`,
      [name, role || null, department || null, notes || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/people/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM people WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/people/:id/profile — save/update a profile for a person
router.post('/:id/profile', requireAuth, async (req, res) => {
  try {
    const { profile_type, content } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO people_profiles (person_id, profile_type, content, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (person_id, profile_type) DO UPDATE
       SET content=EXCLUDED.content, updated_at=NOW()
       RETURNING *`,
      [req.params.id, profile_type, content]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/people/:id/profile/:type
router.delete('/:id/profile/:type', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM people_profiles WHERE person_id=$1 AND profile_type=$2',
      [req.params.id, req.params.type]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
