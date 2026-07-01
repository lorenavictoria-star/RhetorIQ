const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

const router = express.Router();

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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
