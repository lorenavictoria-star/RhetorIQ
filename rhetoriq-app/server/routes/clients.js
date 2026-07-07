const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

async function brevoSend({ to, subject, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('BREVO_API_KEY missing'); return; }

  const payload = JSON.stringify({
    sender: { name: 'Lorena Lienhard', email: process.env.SMTP_FROM || 'contact@lorenalienhard.ch' },
    to: [{ email: to }],
    subject,
    textContent: text
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Brevo API ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendWelcomeEmail({ clientType, salutation, lastName, companyName, email, password, lang }) {
  if (!email) return;
  console.log(`Sending welcome email to ${email} (lang: ${lang}, type: ${clientType})`);

  const isDE = lang === 'de';
  const isCompany = clientType === 'company';

  let salutationLine, subject, intro;

  if (isDE) {
    subject = 'Willkommen bei RhetorIQ – Ihre persönlichen Zugangsdaten';
    salutationLine = isCompany
      ? `Sehr geehrte Damen und Herren von ${companyName},`
      : `Sehr geehrte${salutation === 'Herr' ? 'r Herr' : ' Frau'} ${lastName},`;
    intro = 'es freut mich, Sie bei RhetorIQ willkommen zu heissen.\n\nRhetorIQ gibt Ihnen präzise Werkzeuge für Ihre Führungskommunikation – zugeschnitten auf Ihre Stimme und Ihre Ziele.';
  } else {
    subject = 'Welcome to RhetorIQ – Your Personal Login Details';
    salutationLine = isCompany
      ? `Dear team of ${companyName},`
      : `Dear ${salutation} ${lastName},`;
    intro = 'It is a pleasure to welcome you to RhetorIQ.\n\nRhetorIQ gives you precise tools for your leadership communication – tailored to your voice and your goals.';
  }

  const body = isDE
    ? `${salutationLine}\n\n${intro}\n\nIhre Zugangsdaten:\n\nPlattform: https://rhetoriq.ch\nE-Mail: ${email}\nPasswort: ${password}\n\nBeim ersten Login werden Sie gebeten, ein eigenes Passwort zu vergeben. Danach ist Ihr Zugang vollständig personalisiert und gesichert.\n\nIch freue mich darauf, gemeinsam mit Ihnen zu arbeiten.\n\nHerzlich,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · 079 957 39 76 · lorenalienhard.ch`
    : `${salutationLine}\n\n${intro}\n\nYour login details:\n\nPlatform: https://rhetoriq.ch\nEmail: ${email}\nPassword: ${password}\n\nOn your first login, you will be prompted to set your own password. After that, your access is fully personalised and secured.\n\nI look forward to working with you.\n\nWarm regards,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`;

  await brevoSend({ to: email, subject, text: body });
  console.log(`Welcome email sent to ${email}`);
}

async function sendTokenEmail(clientName, token) {
  const to = process.env.ADVISOR_EMAIL;
  if (!to) return;
  await brevoSend({
    to,
    subject: `RhetorIQ — Neuer Klient: ${clientName}`,
    text: `Neuer Klient wurde angelegt:\n\nName: ${clientName}\nToken: ${token}\n\nTeilen Sie diesen Token mit Ihrem Klienten — damit kann er sich in der App einloggen.\n\nhttps://rhetoriq.ch`
  });
}

const router = express.Router();

// GET /api/clients
router.get('/', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, industry, contact, slug, token, capital_markets_enabled, hotel_enabled, created_at FROM clients WHERE advisor_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients
router.post('/', requireAdvisor, async (req, res) => {
  try {
    const { name, industry, contact, email, initialPassword, clientType, salutation, lastName, emailLang } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36);
    const token = crypto.randomBytes(24).toString('hex');

    let passwordHash = null;
    let mustChange = false;
    if (email && initialPassword) {
      passwordHash = await bcrypt.hash(initialPassword, 12);
      mustChange = true;
    }

    const { rows } = await pool.query(
      'INSERT INTO clients (advisor_id, name, industry, contact, slug, token, email, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user.id, name, industry || '', contact || '', slug, token, email || null, passwordHash, mustChange]
    );

    if (email && initialPassword) {
      sendWelcomeEmail({
        clientType: clientType || 'company',
        salutation: salutation || 'Frau',
        lastName: lastName || '',
        companyName: name,
        email,
        password: initialPassword,
        lang: emailLang || 'de'
      }).catch(e => console.error('Welcome email error:', e.message));
    } else {
      sendTokenEmail(name, token).catch(e => console.error('Token email error:', e.message));
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/export — CSV for Excel
router.get('/export', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, industry, contact, token, created_at FROM clients WHERE advisor_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const esc = v => `"${(v || '').replace(/"/g, '""')}"`;
    const csv = [
      ['Name', 'Industry', 'Contact', 'Token', 'Created'].map(esc).join(','),
      ...rows.map(r => [r.name, r.industry, r.contact, r.token, new Date(r.created_at).toLocaleDateString('de-CH')].map(esc).join(','))
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rhetoriq-clients.csv"');
    res.send('﻿' + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients/:id/send-token
router.post('/:id/send-token', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    const client = rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const to = req.body.email || client.email;
    if (!to) return res.status(400).json({ error: 'No email address available' });

    await brevoSend({
      to,
      subject: 'RhetorIQ – Ihr persönlicher Zugangscode / Your personal access token',
      text: `Access Token für ${client.name} / Access token for ${client.name}:\n\n${client.token}\n\nPlattform / Platform: https://rhetoriq.ch\n\n--\nLorena Lienhard\ncontact@lorenalienhard.ch`
    });

    res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients/:id/set-password
router.post('/:id/set-password', requireAdvisor, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(password, 12);
    const updates = [hash, req.params.id, req.user.id];
    let q = 'UPDATE clients SET password_hash=$1, must_change_password=false';
    if (email) { q += ', email=$4'; updates.push(email); }
    q += ' WHERE id=$2 AND advisor_id=$3';
    await pool.query(q, updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/:id/users — list team members
router.get('/:id/users', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT id, email, name, role, created_at FROM client_users WHERE client_id=$1 ORDER BY created_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clients/:id/users — add team member
router.post('/:id/users', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    const { email, name, password, role = 'editor' } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'Email, name and password required' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO client_users (client_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, email) DO UPDATE SET name=$3, password_hash=$4, role=$5 RETURNING id, email, name, role, created_at',
      [req.params.id, email.toLowerCase(), name, hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/clients/:clientId/users/:userId — remove team member
router.delete('/:id/users/:userId', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM client_users WHERE id=$1 AND client_id=$2', [req.params.userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/clients/:id
// PUT /api/clients/:id/capital-markets-toggle
router.put('/:id/capital-markets-toggle', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET capital_markets_enabled = NOT capital_markets_enabled WHERE id = $1 AND advisor_id = $2 RETURNING capital_markets_enabled',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ capital_markets_enabled: rows[0].capital_markets_enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients/:id/cm-status — accessible by client token too
router.get('/:id/cm-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT capital_markets_enabled, hotel_enabled FROM clients WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ capital_markets_enabled: rows[0].capital_markets_enabled, hotel_enabled: rows[0].hotel_enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clients/:id/hotel-toggle
router.put('/:id/hotel-toggle', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET hotel_enabled = NOT hotel_enabled WHERE id = $1 AND advisor_id = $2 RETURNING hotel_enabled',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ hotel_enabled: rows[0].hotel_enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
