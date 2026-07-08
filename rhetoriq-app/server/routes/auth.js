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

// POST /auth/client-user-login — team member of a client workspace logs in
router.post('/client-user-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await pool.query(
      `SELECT cu.*, c.name as client_name, c.industry, u.name as advisor_name
       FROM client_users cu
       JOIN clients c ON cu.client_id = c.id
       JOIN users u ON c.advisor_id = u.id
       WHERE LOWER(cu.email) = $1`,
      [email.toLowerCase()]
    );
    const cu = rows[0];
    if (!cu || !cu.password_hash) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, cu.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const jwtToken = jwt.sign(
      { clientId: cu.client_id, clientName: cu.client_name, role: 'client', advisorId: null,
        clientUserId: cu.id, clientUserName: cu.name, clientUserRole: cu.role },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.json({
      token: jwtToken,
      client: { id: cu.client_id, name: cu.client_name, industry: cu.industry, advisorName: cu.advisor_name },
      clientUser: { id: cu.id, name: cu.name, email: cu.email, role: cu.role }
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

// POST /auth/register — new advisor registers with invite code
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, inviteCode } = req.body;
    if (!email || !password || !name || !inviteCode)
      return res.status(400).json({ error: 'email, password, name and inviteCode required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Validate invite code
    const { rows: codeRows } = await pool.query(
      `SELECT * FROM invite_codes WHERE code=$1 AND used_by IS NULL AND expires_at > NOW()`,
      [inviteCode.trim().toUpperCase()]
    );
    if (!codeRows[0]) return res.status(400).json({ error: 'Invalid or expired invite code' });

    // Check email not already taken
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
    if (existing.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,\'advisor\') RETURNING id, name, email',
      [email.toLowerCase(), hash, name]
    );
    const user = rows[0];

    // Mark invite code as used
    await pool.query('UPDATE invite_codes SET used_by=$1, used_at=NOW() WHERE id=$2', [user.id, codeRows[0].id]);

    const token = jwt.sign({ id: user.id, role: 'advisor', name: user.name }, process.env.JWT_SECRET, { expiresIn: '90d' });
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/invite — generate invite code (advisor only)
router.post('/invite', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
    const crypto = require('crypto');
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. A3F2B1C4
    await pool.query(
      'INSERT INTO invite_codes (code, created_by) VALUES ($1, $2)',
      [code, req.user.id]
    );
    res.json({ code, expiresIn: '7 days' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Admin reset endpoint — requires RESET_SECRET for security
// Usage: POST /auth/reset-advisor with {email, password, secret}
router.post('/reset-advisor', async (req, res) => {
  const { email, password, secret } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) required' });
  }
  if (!secret || secret !== process.env.RESET_SECRET) {
    return res.status(401).json({ error: 'Invalid reset secret' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    // Delete existing advisor if present
    await pool.query('DELETE FROM users WHERE email = $1 AND role = $2', [email, 'advisor']);
    // Create new advisor
    await pool.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)',
      [email, hash, email.split('@')[0], 'advisor']
    );
    res.json({ ok: true, message: `Advisor ${email} reset successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
