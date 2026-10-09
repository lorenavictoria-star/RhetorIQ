const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const { KI_SATZ } = require('../lib/kiHinweis');

const router = express.Router();

// GET /api/clients/:id/ki-hinweis  (Beraterin und der Klient selbst)
router.get('/:id/ki-hinweis', requireAuth, ownClient('id'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT ki_hinweis FROM clients WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Klient nicht gefunden' });
    res.json({ kiHinweis: !!rows[0].ki_hinweis, satz: KI_SATZ });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/clients/:id/ki-hinweis  { kiHinweis: true|false }  (nur Beraterin)
router.put('/:id/ki-hinweis', requireAdvisor, ownClient('id'), async (req, res) => {
  try {
    await ensureSchema();
    if (typeof req.body.kiHinweis !== 'boolean') return res.status(400).json({ error: 'kiHinweis muss true oder false sein.' });
    await pool.query('UPDATE clients SET ki_hinweis=$1 WHERE id=$2', [req.body.kiHinweis, req.params.id]);
    res.json({ kiHinweis: req.body.kiHinweis, satz: KI_SATZ });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
