// Content-Security-Policy im Report-Only-Modus (Befund F-12) und Endpunkt für die Verstoss-Meldungen des Browsers.
const express = require('express');
const { rateLimit } = require('express-rate-limit');

// Richtlinie für die heutige Seite: Inline-Skripte und Inline-Handler sind nötig ('unsafe-inline'), externe Bibliotheken
// kommen von cdnjs und jsDelivr, Schriften von Google Fonts.
const DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
  'script-src-attr': ["'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'connect-src': ["'self'", 'wss:', 'ws://localhost:*', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
  'worker-src': ["'self'", 'blob:', 'https://cdnjs.cloudflare.com'],
  'media-src': ["'self'", 'blob:', 'data:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'self'"],
  'report-uri': ['/api/csp-report']
};

const router = express.Router();
const limit = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: false, legacyHeaders: false, message: '' });
const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, n);

// Der Browser sendet application/csp-report (oder application/reports+json). Nur eine kurze Zeile ins Protokoll.
router.post('/', limit, express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), (req, res) => {
  try {
    const b = req.body || {};
    const r = b['csp-report'] || (Array.isArray(b) && b[0] && b[0].body) || b.body || {};
    const dir = r['violated-directive'] || r.effectiveDirective || r['effective-directive'] || '?';
    const blocked = r['blocked-uri'] || r.blockedURL || '?';
    const doc = r['document-uri'] || r.documentURL || '?';
    console.log(`[csp-report] ${clip(dir, 60)} blockiert ${clip(blocked, 120)} auf ${clip(doc, 120)}`);
  } catch {}
  res.status(204).end();
});

module.exports = { DIRECTIVES, router };
