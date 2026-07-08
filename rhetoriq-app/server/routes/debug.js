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

module.exports = router;
