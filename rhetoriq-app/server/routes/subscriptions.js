const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/subscriptions?clientId=X  — load all for a client
router.get('/', requireAuth, async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const { rows } = await pool.query(
      'SELECT format, frequency, topic_hint, enabled, last_sent_at FROM content_subscriptions WHERE client_id=$1',
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/subscriptions  — upsert a subscription
router.post('/', requireAuth, async (req, res) => {
  try {
    const { clientId, format, frequency, topicHint, enabled } = req.body;
    if (!clientId || !format) return res.status(400).json({ error: 'clientId and format required' });
    const { rows } = await pool.query(
      `INSERT INTO content_subscriptions (client_id, format, frequency, topic_hint, enabled)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_id, format) DO UPDATE
       SET frequency=EXCLUDED.frequency, topic_hint=EXCLUDED.topic_hint, enabled=EXCLUDED.enabled
       RETURNING *`,
      [clientId, format, frequency || 'weekly', topicHint || null, enabled !== false]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/subscriptions/due?clientId=X  — return formats that are due now
router.get('/due', requireAuth, async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const { rows } = await pool.query(
      `SELECT format, frequency, topic_hint FROM content_subscriptions
       WHERE client_id=$1 AND enabled=TRUE AND (
         last_sent_at IS NULL OR
         (frequency='weekly'   AND last_sent_at < NOW() - INTERVAL '7 days') OR
         (frequency='biweekly' AND last_sent_at < NOW() - INTERVAL '14 days') OR
         (frequency='monthly'  AND last_sent_at < NOW() - INTERVAL '30 days')
       )`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/subscriptions/mark-sent  — update last_sent_at
router.post('/mark-sent', requireAuth, async (req, res) => {
  try {
    const { clientId, format } = req.body;
    await pool.query(
      'UPDATE content_subscriptions SET last_sent_at=NOW() WHERE client_id=$1 AND format=$2',
      [clientId, format]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
