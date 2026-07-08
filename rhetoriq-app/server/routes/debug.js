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

module.exports = router;
