const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();

// GET /api/setup/verify?t=TOKEN — validate a client's 48h onboarding link.
// Returns the client's name/email so the frontend can greet them and show the
// password form, without exposing anything else.
router.get('/verify', async (req, res) => {
  try {
    const { t } = req.query;
    if (!t) return res.status(400).json({ error: 'Token required' });

    const { rows } = await pool.query(
      `SELECT ot.id AS token_id, ot.used_at, ot.expires_at, c.name AS client_name, c.email
       FROM onboarding_tokens ot
       JOIN clients c ON c.id = ot.client_id
       WHERE ot.token = $1`,
      [t]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Link ungültig.' });
    if (row.used_at) return res.status(410).json({ error: 'Dieser Link wurde bereits verwendet.' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Dieser Link ist abgelaufen.' });

    res.json({ clientName: row.client_name, email: row.email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/setup/complete {token, password} — client sets their password via
// the onboarding link, token is consumed, and they're logged in immediately.
router.post('/complete', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token und Passwort erforderlich.' });
    if (password.length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });

    const { rows } = await pool.query(
      `SELECT ot.id AS token_id, ot.used_at, ot.expires_at, c.id AS client_id, c.name AS client_name,
              c.industry, u.name AS advisor_name
       FROM onboarding_tokens ot
       JOIN clients c ON c.id = ot.client_id
       JOIN users u ON u.id = c.advisor_id
       WHERE ot.token = $1`,
      [token]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Link ungültig.' });
    if (row.used_at) return res.status(410).json({ error: 'Dieser Link wurde bereits verwendet.' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Dieser Link ist abgelaufen.' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE clients SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [hash, row.client_id]
    );
    await pool.query('UPDATE onboarding_tokens SET used_at = NOW() WHERE id = $1', [row.token_id]);

    const jwtToken = jwt.sign(
      { clientId: row.client_id, clientName: row.client_name, role: 'client', advisorId: null },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.json({
      token: jwtToken,
      client: { id: row.client_id, name: row.client_name, industry: row.industry, advisorName: row.advisor_name }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
