const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const router = express.Router();

// POST /api/setup/advisor — create or update advisor account
// Query param: ?secret=SETUP_SECRET (from env var or hardcoded for emergency)
router.post('/advisor', async (req, res) => {
  try {
    const { secret } = req.query;
    const requiredSecret = process.env.SETUP_SECRET || 'setup-advisor-2025-temp';
    
    if (!secret || secret !== requiredSecret) {
      return res.status(401).json({ error: 'Invalid setup secret' });
    }

    const email = process.env.ADVISOR_EMAIL;
    const password = process.env.ADVISOR_PASSWORD;
    const name = process.env.ADVISOR_NAME || 'Advisor';

    if (!email || !password) {
      return res.status(400).json({ error: 'ADVISOR_EMAIL and ADVISOR_PASSWORD env vars required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Delete existing account
    await pool.query('DELETE FROM users WHERE email = $1 AND role = $2', [email, 'advisor']);

    // Create new account
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hash, name, 'advisor']
    );

    res.json({
      ok: true,
      message: `Advisor account created: ${email}`,
      id: rows[0].id,
      email,
      name
    });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
