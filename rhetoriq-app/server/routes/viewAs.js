const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { ensureSchema } = require('../lib/schemaRedesign');

// Ansicht des Klienten (nur lesend), gemountet unter /api/advisor.
//   POST /api/advisor/view-as/:clientId       kurzlebiges Lese-Token (30 Min), Eintrag im Zugriffsprotokoll
//   GET  /api/advisor/view-as-log/:clientId   Zugriffsprotokoll
const router = express.Router();
const TOKEN_MINUTES = 30;
const parseId = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

router.post('/view-as/:clientId', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const clientId = parseId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Ungültige ID.' });
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.industry, c.advisor_id, c.token_version, u.name AS advisor_name
       FROM clients c LEFT JOIN users u ON u.id = c.advisor_id
       WHERE c.id=$1 AND c.advisor_id=$2`, [clientId, req.user.id]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    await pool.query('INSERT INTO access_log (advisor_id, client_id) VALUES ($1,$2)', [req.user.id, clientId]);
    // Gleiche Form wie das Klient-Token, dazu viewAs und readOnly. Die Plattform lädt damit wie in der Klient-Sicht;
    // der Server lässt mit diesem Token nur GET-Anfragen zu (middleware/readOnly.js).
    const token = jwt.sign(
      { clientId: c.id, clientName: c.name, role: 'client', advisorId: c.advisor_id, tokenVersion: c.token_version,
        viewAs: true, readOnly: true, viewedBy: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_MINUTES * 60 }
    );
    res.json({
      token,
      expiresInSeconds: TOKEN_MINUTES * 60,
      client: { id: c.id, name: c.name, industry: c.industry, advisorName: c.advisor_name }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/view-as-log/:clientId', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const clientId = parseId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Ungültige ID.' });
    const own = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [clientId, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    const { rows } = await pool.query(
      `SELECT l.id, l.advisor_id, u.name AS advisor_name, l.client_id, l.started_at
       FROM access_log l LEFT JOIN users u ON u.id = l.advisor_id
       WHERE l.client_id=$1 ORDER BY l.started_at DESC, l.id DESC LIMIT 200`, [clientId]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
