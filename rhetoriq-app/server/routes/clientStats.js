const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/clients/:id/top-modules: die drei häufigsten Textarten der letzten 30 Tage.
// Klient nur für die eigene id, Beraterin für ihre Klienten.
const router = express.Router();

router.get('/:id/top-modules', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    if (req.user.role === 'advisor') {
      const own = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [id, req.user.id]);
      if (!own.rows.length) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    } else if (req.user.role !== 'client' || Number(req.user.clientId) !== id) {
      return res.status(403).json({ error: 'Keine Berechtigung.' });
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Text-Generator-Kacheln (E-Mail, LinkedIn, ...) tragen ihren Schlüssel in feedback_key; sonst gilt module.
    const { rows: raw } = await pool.query(
      `SELECT module, feedback_key, COUNT(*)::int AS count
       FROM analyses WHERE client_id=$1 AND created_at >= $2
       GROUP BY module, feedback_key`, [id, since]);
    const sums = new Map();
    for (const r of raw) {
      const key = r.feedback_key || r.module;
      sums.set(key, (sums.get(key) || 0) + r.count);
    }
    const rows = [...sums].map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module)).slice(0, 3);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
