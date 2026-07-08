const express = require('express');
const router = express.Router();

router.get('/status', async (req, res) => {
  const { pool } = require('../db');
  try {
    const { rows } = await pool.query('SELECT id, email, role FROM users WHERE role = $1 LIMIT 1', ['advisor']);
    const account = rows[0];
    res.json({
      status: 'ok',
      db_connected: true,
      advisor_exists: !!account,
      advisor_email: account?.email || 'NOT_FOUND',
      advisor_id: account?.id || null,
      message: account ? 'Account exists' : 'No advisor account found'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      db_connected: false,
      message: err.message
    });
  }
});

router.get('/env', (req, res) => {
  // Show what env vars seedAdvisor() sees (password censored for security)
  res.json({
    ADVISOR_EMAIL: process.env.ADVISOR_EMAIL || 'NOT_SET',
    ADVISOR_PASSWORD: process.env.ADVISOR_PASSWORD ? '(set, length=' + process.env.ADVISOR_PASSWORD.length + ')' : 'NOT_SET',
    ADVISOR_NAME: process.env.ADVISOR_NAME || 'Advisor (default)',
    NODE_ENV: process.env.NODE_ENV || 'development'
  });
});

router.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  const { pool } = require('../db');
  const bcrypt = require('bcryptjs');

  try {
    const { rows } = await pool.query('SELECT id, email, name, password_hash, role FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found', tested_email: email });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    res.json({
      user_exists: true,
      email: user.email,
      password_correct: isMatch,
      role: user.role,
      tested_email: email,
      tested_password_length: password.length,
      message: isMatch ? 'Password matches!' : 'Password does NOT match'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
