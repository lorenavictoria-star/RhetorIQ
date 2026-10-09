const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const dg = require('../lib/durchgang');

const router = express.Router();

// GET /api/messung/durchgang?days=90  (nur Beraterin): Bringt der zweite Durchgang etwas?
router.get('/durchgang', requireAdvisor, async (req, res) => {
  try { res.json(await dg.auswertung(req.user.id, Number(req.query.days) || 90)); }
  catch (e) { console.error('[messung]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
