const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const sk = require('../lib/stilkarte');

const router = express.Router();

// GET /api/stilkarte/:clientId  (Beraterin und der Klient selbst: Hauptzugang oder Rolle admin)
router.get('/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  const u = req.user;
  if (u.role === 'client' && u.clientUserId && u.clientUserRole !== 'admin') return res.status(403).json({ error: 'Die Stilkarte ist für die Rolle Admin und den Hauptzugang vorgesehen.' });
  try {
    const r = await sk.holeKarte(Number(req.params.clientId));
    if (!r) return res.json({ karte: null, zeilen: [], mindestTexte: sk.MIN_TEXTS });
    res.json({ karte: r.karte, zeilen: sk.zeilen(r.karte), aktualisiert: r.aktualisiert, mindestTexte: sk.MIN_TEXTS });
  } catch (e) { console.error('[stilkarte]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
