const express = require('express');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { queueEmail } = require('../lib/emailOutbox');
const { vorabText, ackText, notifyText } = require('../lib/inquiryMails');

// Anfragen aus dem Kontaktformular der Webseite (lorenalienhard.ch).
//   POST /api/inquiry                      oeffentlich, mit geheimem Schluessel (INQUIRY_KEY)
//   GET  /api/inquiries                    Beraterin: Liste (Status "Anfrage" in Kunden)
//   POST /api/inquiries/:id/vorab          Beraterin: Vorab-E-Mail senden (Du oder Sie)
//   POST /api/inquiries/:id/archive        Beraterin: Anfrage ablegen
const publicRouter = express.Router();
const advisorRouter = express.Router();

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT NOT NULL,
      message TEXT,
      source TEXT DEFAULT 'webseite',
      status TEXT NOT NULL DEFAULT 'neu',
      anrede TEXT,
      workshop_date TEXT,
      ack_sent_at TIMESTAMPTZ,
      vorab_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  tableEnsured = true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const inquiryLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});

publicRouter.post('/', inquiryLimit, async (req, res) => {
  try {
    const secret = process.env.INQUIRY_KEY;
    if (!secret) return res.status(503).json({ error: 'Anfragen sind nicht eingerichtet.' });
    const given = req.headers['x-inquiry-key'] || req.body.key;
    if (!sameKey(given, secret)) return res.status(401).json({ error: 'Nicht erlaubt.' });

    // Honeypot: dieses versteckte Feld füllen nur Bots aus.
    if (req.body.website2) return res.json({ ok: true });

    const name = clip(req.body.name, 120);
    const email = clip(req.body.email, 200).toLowerCase();
    const company = clip(req.body.company, 160);
    const message = clip(req.body.message, 4000);
    if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Name und gültige E-Mail erforderlich.' });

    await ensureTable();
    // Doppelte Absendungen derselben Adresse innert 10 Minuten zusammenfassen.
    const dup = await pool.query(
      `SELECT id FROM inquiries WHERE email=$1 AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`, [email]);
    if (dup.rows.length) return res.json({ ok: true });

    const { rows } = await pool.query(
      `INSERT INTO inquiries (name, company, email, message) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, company, email, message]);
    const id = rows[0].id;

    // Eingangsbestätigung an die Anfragende Person (Sie-Form, weil noch nichts geklärt ist).
    const ack = ackText({ name });
    queueEmail({ kind: 'inquiry_ack', to: email, subject: 'Ihre Anfrage bei RhetorIQ', text: ack, senderName: 'Lorena Lienhard' })
      .then(() => pool.query('UPDATE inquiries SET ack_sent_at=NOW() WHERE id=$1', [id]))
      .catch(e => console.error('[inquiry] ack failed:', e.message));

    // Hinweis an die Beraterin.
    const notifyTo = process.env.ADVISOR_NOTIFY_EMAIL || process.env.SMTP_FROM || 'contact@lorenalienhard.ch';
    const note = notifyText({ name, company, email, message });
    queueEmail({ kind: 'inquiry_notify', to: notifyTo, subject: `Neue Anfrage: ${company || name}`, text: note })
      .catch(e => console.error('[inquiry] notify failed:', e.message));

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, company, email, message, status, anrede, workshop_date, ack_sent_at, vorab_sent_at, created_at
       FROM inquiries WHERE status != 'archiviert' ORDER BY created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.post('/:id/vorab', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    const id = parseInt(req.params.id, 10);
    const anrede = req.body.anrede === 'du' ? 'du' : 'sie';
    const titel = ['Frau', 'Herr'].includes(req.body.titel) ? req.body.titel : '';
    const datum = clip(req.body.datum, 80);
    if (!datum) return res.status(400).json({ error: 'Bitte den Workshop-Termin angeben.' });
    const { rows } = await pool.query('SELECT * FROM inquiries WHERE id=$1', [id]);
    const q = rows[0];
    if (!q) return res.status(404).json({ error: 'Anfrage nicht gefunden.' });
    const text = vorabText({ name: q.name, anrede, titel, datum });
    await queueEmail({ kind: 'inquiry_vorab', to: q.email, subject: `Unser Workshop am ${datum}`, text, senderName: 'Lorena Lienhard' });
    await pool.query(
      `UPDATE inquiries SET status='vorab_gesendet', anrede=$1, workshop_date=$2, vorab_sent_at=NOW() WHERE id=$3`,
      [anrede, datum, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

advisorRouter.post('/:id/archive', requireAdvisor, async (req, res) => {
  try {
    await ensureTable();
    await pool.query(`UPDATE inquiries SET status='archiviert' WHERE id=$1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { publicRouter, advisorRouter };
