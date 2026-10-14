const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const events = require('../lib/siteEvents');

// POST /api/ev { e: "view_home" } zählt ein anonymes Ereignis. Nur von rhetoriq.ch, nur bekannte Namen, ohne Antwortinhalt.
const ALLOWED_ORIGINS = ['https://rhetoriq.ch', 'https://www.rhetoriq.ch'];
const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, max: 40, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: false, legacyHeaders: false, handler: (_, res) => res.status(204).end() }));
router.post('/', express.json({ limit: '1kb' }), async (req, res) => {
  const origin = String(req.headers.origin || req.headers.referer || '');
  if (!ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + '/'))) return res.status(204).end();
  try { await events.record(pool, req.body && req.body.e); } catch (e) { console.error('[ev]', e.message); }
  res.status(204).end();
});
module.exports = router;
