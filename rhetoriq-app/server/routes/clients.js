const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');

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
    from: `"RhetorIQ" <${user}>`,
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
    const { name, industry, contact, email, initialPassword } = req.body;
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
    sendTokenEmail(name, token).catch(e => console.error('Email error:', e.message));
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
