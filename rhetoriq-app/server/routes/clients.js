const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { brevoSend: brevoSendShared } = require('../lib/brevo');

const brevoSend = (opts) => brevoSendShared({ senderName: 'Lorena Lienhard', ...opts });

// Generate a secure 48-hour setup link and send it instead of a plaintext password.
// The client clicks the link, sets their own password — no credentials ever in email.
async function sendWelcomeEmail({ clientType, salutation, lastName, companyName, email, clientId, lang }) {
  if (!email) return;

  // Create onboarding token (48 h TTL)
  const setupToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO onboarding_tokens (client_id, token) VALUES ($1, $2)',
    [clientId, setupToken]
  );

  const BASE = process.env.APP_URL || 'https://rhetoriq.ch';
  const setupLink = `${BASE}/setup?t=${setupToken}`;

  const isDE = lang === 'de';
  const isCompany = clientType === 'company';

  const salutationLine = isDE
    ? (isCompany
        ? `Sehr geehrte Damen und Herren von ${companyName},`
        : `Sehr geehrte${salutation === 'Herr' ? 'r Herr' : ' Frau'} ${lastName},`)
    : (isCompany
        ? `Dear team of ${companyName},`
        : `Dear ${salutation} ${lastName},`);

  const subject = isDE
    ? 'Willkommen bei RhetorIQ – Ihren Zugang einrichten'
    : 'Welcome to RhetorIQ – Set up your access';

  const body = isDE
    ? `${salutationLine}\n\nes freut mich, Sie bei RhetorIQ willkommen zu heissen.\n\nRhetorIQ gibt Ihnen präzise Werkzeuge für Ihre Führungskommunikation – zugeschnitten auf Ihre Stimme und Ihre Ziele.\n\nBitte richten Sie Ihren persönlichen Zugang über den folgenden Link ein:\n\n${setupLink}\n\nDieser Link ist 48 Stunden gültig. Sie werden dort aufgefordert, ein eigenes Passwort zu wählen. Danach ist Ihr Zugang vollständig personalisiert und gesichert.\n\nE-Mail: ${email}\nPlattform: https://rhetoriq.ch\n\nIch freue mich darauf, gemeinsam mit Ihnen zu arbeiten.\n\nHerzlich,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`
    : `${salutationLine}\n\nIt is a pleasure to welcome you to RhetorIQ.\n\nRhetorIQ gives you precise tools for your leadership communication – tailored to your voice and your goals.\n\nPlease set up your personal access using the link below:\n\n${setupLink}\n\nThis link is valid for 48 hours. You will be prompted to choose your own password. After that, your access is fully personalised and secured.\n\nEmail: ${email}\nPlatform: https://rhetoriq.ch\n\nI look forward to working with you.\n\nWarm regards,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`;

  await brevoSend({ to: email, subject, text: body });
  console.log(`Welcome email (setup link) sent to ${email}`);
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
    await ensureClientAddressColumn();
    const { rows } = await pool.query(
      'SELECT id, name, industry, contact, slug, token, capital_markets_enabled, hotel_enabled, enabled_modules, address, created_at FROM clients WHERE advisor_id = $1 ORDER BY created_at DESC',
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
    const { name, industry, contact, email, initialPassword, clientType, salutation, lastName, emailLang, privacyAcknowledged, sector, enabled_modules } = req.body;
    if (!name || name.length > 200) return res.status(400).json({ error: 'Name required (max 200 chars)' });
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (industry && industry.length > 200) return res.status(400).json({ error: 'Industry max 200 chars' });
    if (contact && contact.length > 500) return res.status(400).json({ error: 'Contact max 500 chars' });
    if (!privacyAcknowledged) return res.status(400).json({ error: 'Datenschutz-Bestätigung erforderlich' });

    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36);
    const token = crypto.randomBytes(24).toString('hex');

    const mods = Array.isArray(enabled_modules) && enabled_modules.length ? enabled_modules : null;
    const { rows } = await pool.query(
      'INSERT INTO clients (advisor_id, name, industry, contact, slug, token, email, must_change_password, privacy_acknowledged_at, enabled_modules) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9) RETURNING *',
      [req.user.id, name, industry || '', contact || '', slug, token, email || null, !!email, mods]
    );

    if (email) {
      // Send secure setup link — no password in email
      sendWelcomeEmail({
        clientType: clientType || 'company',
        salutation: salutation || 'Frau',
        lastName: lastName || '',
        companyName: name,
        email,
        clientId: rows[0].id,
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
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/send-welcome — (re)send the password-setup welcome
// email for a client that was created earlier without triggering it yet.
router.post('/:id/send-welcome', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    const client = rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const email = req.body.email || client.email;
    if (!email) return res.status(400).json({ error: 'No email address available' });

    if (email !== client.email) {
      await pool.query('UPDATE clients SET email=$1, must_change_password=true WHERE id=$2', [email, client.id]);
    }

    await sendWelcomeEmail({
      clientType: req.body.clientType || 'company',
      salutation: req.body.salutation || 'Frau',
      lastName: req.body.lastName || '',
      companyName: client.name,
      email,
      clientId: client.id,
      lang: req.body.lang || 'de'
    });

    res.json({ ok: true, sentTo: email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/set-password
router.post('/:id/set-password', requireAdvisor, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 12);
    const updates = [hash, req.params.id, req.user.id];
    let q = 'UPDATE clients SET password_hash=$1, must_change_password=false';
    if (email) { q += ', email=$4'; updates.push(email); }
    q += ' WHERE id=$2 AND advisor_id=$3';
    await pool.query(q, updates);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/revoke-access — instantly invalidate every JWT
// currently held by this client and all of its team members (client_users),
// without waiting for natural expiry. Use for off-boarding or a suspected leak.
router.post('/:id/revoke-access', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET token_version = token_version + 1 WHERE id=$1 AND advisor_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    await pool.query('UPDATE client_users SET token_version = token_version + 1 WHERE client_id=$1', [req.params.id]);
    res.json({ ok: true, message: 'All active sessions for this client have been revoked.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/clients/:id/users — add team member
router.post('/:id/users', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    const { email, name, password, role = 'editor' } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'Email, name and password required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO client_users (client_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, email) DO UPDATE SET name=$3, password_hash=$4, role=$5 RETURNING id, email, name, role, created_at',
      [req.params.id, email.toLowerCase(), name, hash, role]
    );

    // Also add them to the People directory (Voice DNA etc.) if not already
    // there, so a new team member is immediately available for per-person
    // features like Speaker Voice DNA — skip if a person with this name
    // already exists for this client to avoid duplicates.
    const { rows: existingPeople } = await pool.query(
      'SELECT id FROM people WHERE client_id=$1 AND LOWER(name)=LOWER($2)',
      [req.params.id, name]
    );
    if (!existingPeople.length) {
      await pool.query('INSERT INTO people (client_id, name) VALUES ($1,$2)', [req.params.id, name]);
    }

    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/clients/:clientId/users/:userId — remove team member
router.delete('/:id/users/:userId', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM client_users WHERE id=$1 AND client_id=$2', [req.params.userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/clients/:id
// PUT /api/clients/:id/capital-markets-toggle
// PUT /api/clients/:id/address — the client's own sender address, used to
// auto-fill "Sender (Absender)" when generating a formal Brief for this client.
let clientAddressColumnEnsured = false;
async function ensureClientAddressColumn() {
  if (clientAddressColumnEnsured) return;
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT`);
  clientAddressColumnEnsured = true;
}
router.put('/:id/address', requireAdvisor, async (req, res) => {
  try {
    await ensureClientAddressColumn();
    const { address } = req.body;
    const { rows } = await pool.query(
      'UPDATE clients SET address=$1 WHERE id=$2 AND advisor_id=$3 RETURNING address',
      [address || '', req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ address: rows[0].address });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/capital-markets-toggle', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET capital_markets_enabled = NOT capital_markets_enabled WHERE id = $1 AND advisor_id = $2 RETURNING capital_markets_enabled',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ capital_markets_enabled: rows[0].capital_markets_enabled });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/cm-status — accessible by client token too
router.get('/:id/cm-status', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'client' && req.user.clientId != req.params.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'advisor') {
      const { rows: ownerCheck } = await pool.query(
        'SELECT id FROM clients WHERE id=$1 AND advisor_id=$2',
        [req.params.id, req.user.id]
      );
      if (!ownerCheck[0]) return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      'SELECT capital_markets_enabled, hotel_enabled, enabled_modules FROM clients WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({
      capital_markets_enabled: rows[0].capital_markets_enabled,
      hotel_enabled: rows[0].hotel_enabled,
      enabled_modules: rows[0].enabled_modules || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/modules-config
router.put('/:id/modules-config', requireAdvisor, async (req, res) => {
  try {
    const { modules } = req.body;
    if (!Array.isArray(modules)) return res.status(400).json({ error: 'modules must be an array' });
    const { rows } = await pool.query(
      'UPDATE clients SET enabled_modules = $1 WHERE id = $2 AND advisor_id = $3 RETURNING enabled_modules',
      [modules, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ enabled_modules: rows[0].enabled_modules });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
