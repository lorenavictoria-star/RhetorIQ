const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /auth/login — advisor login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/client-login — client logs in via their token
router.post('/client-login', async (req, res) => {
  try {
    const { token: clientToken } = req.body;
    if (!clientToken) return res.status(400).json({ error: 'Token required' });

    const { rows } = await pool.query(
      'SELECT c.*, u.name as advisor_name FROM clients c JOIN users u ON c.advisor_id = u.id WHERE c.token = $1',
      [clientToken]
    );
    const client = rows[0];
    if (!client) return res.status(401).json({ error: 'Invalid client token' });

    const jwtToken = jwt.sign(
      { clientId: client.id, clientName: client.name, role: 'client', advisorId: client.advisor_id },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.json({
      token: jwtToken,
      client: { id: client.id, name: client.name, industry: client.industry, advisorName: client.advisor_name }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/client-password-login — client logs in with email + password
router.post('/client-password-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await pool.query(
      'SELECT c.*, u.name as advisor_name FROM clients c JOIN users u ON c.advisor_id = u.id WHERE LOWER(c.email) = $1',
      [email.toLowerCase()]
    );
    const client = rows[0];
    if (!client || !client.password_hash) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, client.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const jwtToken = jwt.sign(
      { clientId: client.id, clientName: client.name, role: 'client', advisorId: client.advisor_id, mustChangePassword: !!client.must_change_password },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.json({
      token: jwtToken,
      client: { id: client.id, name: client.name, industry: client.industry, advisorName: client.advisor_name },
      mustChangePassword: !!client.must_change_password
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/client-change-password — client sets new password (first login or self-service)
router.post('/client-change-password', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Forbidden' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE clients SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [hash, req.user.clientId]
    );

    const { rows } = await pool.query(
      'SELECT c.*, u.name as advisor_name FROM clients c JOIN users u ON c.advisor_id = u.id WHERE c.id = $1',
      [req.user.clientId]
    );
    const client = rows[0];
    const newToken = jwt.sign(
      { clientId: client.id, clientName: client.name, role: 'client', advisorId: client.advisor_id, mustChangePassword: false },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.json({ token: newToken, client: { id: client.id, name: client.name, industry: client.industry, advisorName: client.advisor_name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
