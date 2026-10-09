const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const lk = require('../lib/lernkurve');

const router = express.Router();

// GET /api/lernkurve/:clientId  (Beraterin und der Klient selbst: Hauptzugang oder Rolle admin)
router.get('/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  const u = req.user;
  if (u.role === 'client' && u.clientUserId && u.clientUserRole !== 'admin') return res.status(403).json({ error: 'Die Lernkurve ist für die Rolle Admin und den Hauptzugang vorgesehen.' });
  try {
    const d = await lk.lernkurve(Number(req.params.clientId), Number(req.query.monate) || 6);
    if (u.role === 'client') delete d.satzBeraterin;
    res.json(d);
  } catch (e) { console.error('[lernkurve]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
