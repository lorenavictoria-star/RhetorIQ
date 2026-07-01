const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

function makeTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    console.error('SMTP not configured: SMTP_USER or SMTP_PASS missing');
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
    family: 4
  });
}

// FROM address: use SMTP_FROM env var if set, otherwise fall back to SMTP_USER
function fromAddress() {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  return `"Lorena Lienhard" <${from}>`;
}

async function sendWelcomeEmail({ clientType, salutation, lastName, companyName, email, password, lang }) {
  const transporter = makeTransporter();
  if (!transporter || !email) return;
  console.log(`Sending welcome email to ${email} (lang: ${lang}, type: ${clientType})`);

  const isDE = lang === 'de';
  const isCompany = clientType === 'company';

  let salutationLine, subject, intro;

  if (isDE) {
    subject = 'Willkommen bei RhetorIQ – Ihre persönlichen Zugangsdaten';
    if (isCompany) {
      salutationLine = `Sehr geehrte Damen und Herren von ${companyName},`;
    } else {
      salutationLine = `Sehr geehrte${salutation === 'Herr' ? 'r Herr' : ' Frau'} ${lastName},`;
    }
    intro = 'es freut mich, Sie bei RhetorIQ willkommen zu heissen.\n\nRhetorIQ gibt Ihnen präzise Werkzeuge für Ihre Führungskommunikation – zugeschnitten auf Ihre Stimme und Ihre Ziele.';
  } else {
    subject = 'Welcome to RhetorIQ – Your Personal Login Details';
    if (isCompany) {
      salutationLine = `Dear team of ${companyName},`;
    } else {
      salutationLine = `Dear ${salutation} ${lastName},`;
    }
    intro = 'It is a pleasure to welcome you to RhetorIQ.\n\nRhetorIQ gives you precise tools for your leadership communication – tailored to your voice and your goals.';
  }

  const body = isDE
    ? `${salutationLine}\n\n${intro}\n\nIhre Zugangsdaten:\n\nPlattform: https://rhetoriq.ch\nE-Mail: ${email}\nPasswort: ${password}\n\nBeim ersten Login werden Sie gebeten, ein eigenes Passwort zu vergeben. Danach ist Ihr Zugang vollständig personalisiert und gesichert.\n\nIch freue mich darauf, gemeinsam mit Ihnen zu arbeiten.\n\nHerzlich,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · 079 957 39 76 · lorenalienhard.ch`
    : `${salutationLine}\n\n${intro}\n\nYour login details:\n\nPlatform: https://rhetoriq.ch\nEmail: ${email}\nPassword: ${password}\n\nOn your first login, you will be prompted to set your own password. After that, your access is fully personalised and secured.\n\nI look forward to working with you.\n\nWarm regards,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`;

  const info = await transporter.sendMail({
    from: fromAddress(),
    to: email,
    subject,
    text: body
  });
  console.log(`Welcome email sent: ${info.messageId} → ${email}`);
}

async function sendTokenEmail(clientName, token) {
  const to = process.env.ADVISOR_EMAIL;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!to || !user || !pass) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user, pass }
  });
  await transporter.sendMail({
    from: fromAddress(),
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
      'SELECT id, name, industry, contact, slug, token, created_at FROM clients WHERE advisor_id = $1 ORDER BY created_at DESC',
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
      }).catch(e => console.error('Welcome email error:', e.message, e.code || ''));
    } else {
      sendTokenEmail(name, token).catch(e => console.error('Email error:', e.message));
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
    res.send('﻿' + csv); // BOM for Excel UTF-8
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients/:id/send-token — send token email to a given address
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

    const transporter = makeTransporter();
    if (!transporter) return res.status(500).json({ error: 'SMTP not configured' });

    await transporter.sendMail({
      from: fromAddress(),
      to,
      subject: `RhetorIQ – Ihr persönlicher Zugangscode / Your personal access token`,
      text: `Access Token für ${client.name} / Access token for ${client.name}:\n\n${client.token}\n\nPlattform / Platform: https://rhetoriq.ch\n\n--\nLorena Lienhard\ncontact@lorenalienhard.ch`
    });

    res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clients/:id
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
