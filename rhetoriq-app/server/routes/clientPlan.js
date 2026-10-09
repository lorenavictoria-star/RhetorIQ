const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');

const router = express.Router();
const PLANS = ['starter', 'wachstum', 'team', 'enterprise'];

// GET /api/client-plan/:clientId  (Beraterin und der Klient selbst)
router.get('/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT recommended_plan, name FROM clients WHERE id=$1', [req.params.clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Klient nicht gefunden' });
    res.json({ plan: rows[0].recommended_plan || null, name: rows[0].name });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/client-plan/:clientId  { plan: 'team' | null }  (nur Beraterin)
router.put('/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const plan = req.body.plan == null || req.body.plan === '' ? null : String(req.body.plan).toLowerCase();
    if (plan && !PLANS.includes(plan)) return res.status(400).json({ error: 'Unbekanntes Paket.' });
    await pool.query('UPDATE clients SET recommended_plan=$1 WHERE id=$2', [plan, req.params.clientId]);
    res.json({ plan });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
