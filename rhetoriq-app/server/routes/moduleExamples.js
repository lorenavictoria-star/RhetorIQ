const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

const router = express.Router();

// GET /api/module-examples?moduleKey=xxx
router.get('/', requireAdvisor, async (req, res) => {
  try {
    const { moduleKey } = req.query;
    let q = 'SELECT * FROM module_examples WHERE advisor_id=$1';
    const params = [req.user.id];
    if (moduleKey) { q += ' AND module_key=$2'; params.push(moduleKey); }
    q += ' ORDER BY rating DESC, created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/module-examples
router.post('/', requireAdvisor, async (req, res) => {
  try {
    const { module_key, label, input_text, output_text, rating = 3 } = req.body;
    if (!module_key || !input_text || !output_text)
      return res.status(400).json({ error: 'module_key, input_text and output_text required' });
    const { rows } = await pool.query(
      'INSERT INTO module_examples (advisor_id,module_key,label,input_text,output_text,rating) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, module_key, label || null, input_text, output_text, rating]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/module-examples/for-inject?moduleKey=xxx&advisorId=yyy  (internal use by analyze)
router.get('/for-inject', async (req, res) => {
  try {
    const { moduleKey, advisorId } = req.query;
    if (!moduleKey || !advisorId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT input_text, output_text FROM module_examples WHERE advisor_id=$1 AND module_key=$2 ORDER BY rating DESC, created_at DESC LIMIT 3',
      [advisorId, moduleKey]
    );
    res.json(rows);
  } catch (e) { res.json([]); }
});

module.exports = router;
