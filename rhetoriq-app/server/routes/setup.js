const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const router = express.Router();

// GET /api/setup/verify?t=<token> — check if token is valid (called when page loads)
router.get('/verify', async (req, res) => {
  try {
    const { t } = req.query;
    if (!t) return res.status(400).json({ error: 'Token required' });

    const { rows } = await pool.query(
      `SELECT ot.id, ot.client_id, c.name, c.email
       FROM onboarding_tokens ot
       JOIN clients c ON c.id = ot.client_id
       WHERE ot.token = $1
         AND ot.used_at IS NULL
         AND ot.expires_at > NOW()`,
      [t]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Link ungültig oder abgelaufen.' });

    res.json({ valid: true, clientName: rows[0].name, email: rows[0].email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/setup/complete — set password and mark token used
router.post('/complete', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });
    }

    const { rows } = await pool.query(
      `SELECT ot.id, ot.client_id
       FROM onboarding_tokens ot
       WHERE ot.token = $1
         AND ot.used_at IS NULL
         AND ot.expires_at > NOW()`,
      [token]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Link ungültig oder abgelaufen.' });

    const { id: tokenId, client_id } = rows[0];
    const hash = await bcrypt.hash(password, 12);

    await pool.query('BEGIN');
    try {
      await pool.query(
        'UPDATE clients SET password_hash=$1, must_change_password=false WHERE id=$2',
        [hash, client_id]
      );
      await pool.query(
        'UPDATE onboarding_tokens SET used_at=NOW() WHERE id=$1',
        [tokenId]
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
