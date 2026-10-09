const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { pool } = require('../db');
const sn = require('../lib/stimmnaehe');

const router = express.Router();

// GET /api/stimmnaehe/analyse/:id  (nur Beraterin, nur eigene Klienten)
router.get('/analyse/:id(\\d+)', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT client_id FROM analyses WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const { canAccessClient } = require('../middleware/ownership');
    if (!(await canAccessClient(req, rows[0].client_id))) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    const z = await sn.zuAnalyse(Number(req.params.id));
    res.json(z ? { wert: z.wert, merkmale: z.details } : { wert: null });
  } catch (e) { console.error('[stimmnaehe]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/stimmnaehe/:clientId  (nur Beraterin): Durchschnitt je Monat
router.get('/:clientId(\\d+)', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { res.json({ monate: await sn.monatsDurchschnitt(Number(req.params.clientId), Number(req.query.monate) || 6) }); }
  catch (e) { console.error('[stimmnaehe]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
