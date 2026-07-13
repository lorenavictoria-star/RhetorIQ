const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

const router = express.Router();

// GET/PUT /api/advisor/sender-address — advisor's own company address, used to
// auto-fill the "Sender (Absender)" field on the Brief / formal-letter module.
let senderAddressColumnEnsured = false;
async function ensureSenderAddressColumn() {
  if (senderAddressColumnEnsured) return;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sender_address TEXT`);
  senderAddressColumnEnsured = true;
}

router.get('/sender-address', requireAdvisor, async (req, res) => {
  try {
    await ensureSenderAddressColumn();
    const { rows } = await pool.query('SELECT sender_address FROM users WHERE id=$1', [req.user.id]);
    res.json({ senderAddress: rows[0]?.sender_address || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/sender-address', requireAdvisor, async (req, res) => {
  try {
    await ensureSenderAddressColumn();
    const { senderAddress } = req.body;
    await pool.query('UPDATE users SET sender_address=$1 WHERE id=$2', [senderAddress || '', req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/dashboard
router.get('/dashboard', requireAdvisor, async (req, res) => {
  try {
    const advisorId = req.user.id;

    const [clientsRes, statsRes, recentRes] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.industry, c.created_at,
          COUNT(a.id) AS total_analyses,
          MAX(a.created_at) AS last_activity,
          COUNT(CASE WHEN a.created_at > NOW() - INTERVAL '7 days' THEN 1 END) AS analyses_7d
         FROM clients c
         LEFT JOIN analyses a ON a.client_id = c.id AND a.advisor_id = $1
         WHERE c.advisor_id = $1
         GROUP BY c.id ORDER BY last_activity DESC NULLS LAST`,
        [advisorId]
      ),
      pool.query(
        `SELECT
          COUNT(DISTINCT c.id) AS total_clients,
          COUNT(a.id) FILTER (WHERE a.created_at > NOW() - INTERVAL '30 days') AS analyses_30d,
          COUNT(DISTINCT a.client_id) FILTER (WHERE a.created_at > NOW() - INTERVAL '7 days') AS active_clients_7d
         FROM clients c
         LEFT JOIN analyses a ON a.client_id = c.id AND a.advisor_id = $1
         WHERE c.advisor_id = $1`,
        [advisorId]
      ),
      pool.query(
        `SELECT a.id, a.module, a.module_label, a.created_at, c.name AS client_name
         FROM analyses a
         JOIN clients c ON c.id = a.client_id
         WHERE a.advisor_id = $1
         ORDER BY a.created_at DESC LIMIT 20`,
        [advisorId]
      )
    ]);

    res.json({
      stats: statsRes.rows[0],
      clients: clientsRes.rows,
      recent: recentRes.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/timeline/:clientId
router.get('/timeline/:clientId', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, module, module_label, created_at
       FROM analyses
       WHERE client_id = $1 AND advisor_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.clientId, req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/costs — token costs per client (last 30 days)
// Pricing: claude-sonnet-4-6 = $3/MTok input, $15/MTok output
const PRICE_INPUT  = 3  / 1_000_000; // USD per token
const PRICE_OUTPUT = 15 / 1_000_000;

router.get('/costs', requireAdvisor, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    if (days < 1 || days > 365) return res.status(400).json({ error: 'days must be 1–365' });

    const { rows } = await pool.query(`
      SELECT
        COALESCE(c.name, 'Ohne Klient') AS client_name,
        ul.client_id,
        COUNT(*)::int                          AS calls,
        SUM(ul.input_tokens)::bigint           AS input_tokens,
        SUM(ul.output_tokens)::bigint          AS output_tokens,
        ROUND(
          (SUM(ul.input_tokens) * $2 + SUM(ul.output_tokens) * $3)::numeric, 4
        )                                      AS cost_usd
      FROM usage_log ul
      LEFT JOIN clients c ON c.id = ul.client_id
      WHERE ul.advisor_id = $1
        AND ul.created_at > NOW() - ($4 || ' days')::interval
      GROUP BY ul.client_id, c.name
      ORDER BY cost_usd DESC
    `, [req.user.id, PRICE_INPUT, PRICE_OUTPUT, days]);

    const total = rows.reduce((sum, r) => sum + parseFloat(r.cost_usd || 0), 0);

    res.json({ days, rows, total_usd: total.toFixed(4) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
