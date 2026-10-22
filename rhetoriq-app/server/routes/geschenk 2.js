// Geschenk-PDFs als Lead-Magnet. Die PDFs werden nie ausgeliefert, sondern per Mail verschickt.
//   GET  /api/geschenk/ticket      Ticket gegen schnelle Bots
//   POST /api/geschenk             { geschenk: 'prompt' | 'leitfaden', name, email, einwilligung, website2, ticket }
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const B = require('../lib/buchung');
const G = require('../lib/geschenk');
const M = require('../lib/leadMails');
const MB = require('../lib/missbrauch');
const { queueEmail } = require('../lib/emailOutbox');
const { advisorEmails } = require('../lib/notify');

const TAGESLIMIT = 120; // Geschenk-Leads je 24 Stunden insgesamt
const basisUrl = () => (process.env.BUCHUNG_BASIS_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const mailSicher = (m) => Promise.resolve().then(() => queueEmail(m)).catch(e => console.error('[geschenk] Mail fehlgeschlagen:', m.kind, e && e.message));

function build(opts = {}) {
  const { ipMax = 8, ticketMax = 120, emailMax = 3, jetzt = () => new Date(), minAlterMs = MB.MIN_ALTER_MS } = opts;
  const router = express.Router();
  const emailZaehler = MB.zaehler(emailMax, 3600000);
  const ipKey = (req) => ipKeyGenerator(req.ip);
  const mk = (max, windowMs) => rateLimit({ windowMs, max, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es später noch einmal.' } });
  const ticketLimit = mk(ticketMax, 5 * 60 * 1000);
  const sendeLimit = mk(ipMax, 60 * 60 * 1000);
  router._zaehler = emailZaehler;
  const fehler500 = (res, e) => { console.error('[geschenk]', e && e.message); res.status(500).json({ error: 'Das hat leider nicht geklappt. Bitte versuchen Sie es noch einmal oder senden Sie mir eine Nachricht.' }); };

  router.get('/ticket', ticketLimit, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ticket: B.ticketNeu(jetzt()) });
  });

  router.post('/', sendeLimit, async (req, res) => {
    try {
      if (!MB.vonUnsererSeite(req)) return res.status(401).json({ error: 'Nicht erlaubt.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (body.website2) return res.json({ ok: true }); // Honeypot
      const alter = B.ticketAlter(body.ticket, jetzt());
      if (alter == null || alter > MB.MAX_ALTER_MS || alter < 0) return res.status(400).json({ error: 'Bitte laden Sie die Seite neu und versuchen Sie es noch einmal.' });
      if (alter < minAlterMs) return res.status(429).json({ error: 'Bitte nehmen Sie sich einen Moment Zeit und versuchen Sie es dann noch einmal.' });
      for (const k of ['geschenk', 'name', 'email']) if (body[k] != null && typeof body[k] !== 'string') return res.status(400).json({ error: 'Die Angaben sind unvollständig oder ungültig.', feld: k });
      const g = G.finde(String(body.geschenk || ''));
      if (!g) return res.status(400).json({ error: 'Bitte wählen Sie ein Geschenk aus.', feld: 'geschenk' });
      const name = MB.pruefeName(body.name, B.einZeile);
      if (!name) return res.status(400).json({ error: 'Bitte geben Sie Ihren Namen an.', feld: 'name' });
      const email = String(body.email || '').trim().toLowerCase();
      if (email.length > 120 || !B.EMAIL_RE.test(email)) return res.status(400).json({ error: 'Bitte geben Sie eine gültige E-Mail-Adresse an.', feld: 'email' });
      if (body.einwilligung !== true) return res.status(400).json({ error: 'Bitte bestätigen Sie die Datenschutzerklärung und die Kontaktaufnahme.', feld: 'einwilligung' });
      if (!emailZaehler.erlaubt('e:' + email, jetzt().getTime())) return res.status(429).json({ error: 'Es gab in kurzer Zeit zu viele Versuche. Bitte versuchen Sie es später noch einmal.' });

      const inq = require('./inquiries');
      await inq.ensureTable();
      const seit = new Date(jetzt().getTime() - 24 * 3600000);
      // Dasselbe Geschenk geht an dieselbe Adresse höchstens einmal je 24 Stunden (schützt Dritte vor Mail-Fluten)
      const dup = await pool.query('SELECT id FROM inquiries WHERE email=$1 AND source=$2 AND created_at > $3 LIMIT 1', [email, g.source, seit]);
      if (dup.rows.length) return res.json({ ok: true, schon: true, titel: g.titel });
      const heute = await pool.query(`SELECT COUNT(*)::int AS n FROM inquiries WHERE source IN ($1,$2) AND created_at > $3`, [G.GESCHENKE.prompt.source, G.GESCHENKE.leitfaden.source, seit]);
      if (heute.rows[0].n >= TAGESLIMIT) return res.status(429).json({ error: 'Heute sind leider keine weiteren Geschenke möglich. Bitte versuchen Sie es morgen noch einmal oder senden Sie mir eine Nachricht.' });

      let anhang;
      try { anhang = G.anhang(g); } catch (e) { console.error('[geschenk] PDF nicht lesbar:', e && e.message); return res.status(500).json({ error: 'Das Geschenk ist gerade nicht verfügbar. Bitte senden Sie mir eine Nachricht.' }); }
      const message = `Geschenk angefordert: ${g.titel}.\nEinwilligung zur Datenschutzerklärung und zur Kontaktaufnahme liegt vor.`;
      await pool.query(`INSERT INTO inquiries (name, email, message, source, ack_sent_at, created_at) VALUES ($1,$2,$3,$4,NOW(),$5)`, [name, email, message, g.source, jetzt()]);

      const urls = { terminUrl: basisUrl() + '/termin', schnelltestUrl: basisUrl() + '/#schnelltest' };
      const m = M.geschenkMail(name, g, urls);
      mailSicher({ kind: 'geschenk_pdf', to: email, subject: m.subject, text: m.text, senderName: 'Lorena Lienhard', attachments: anhang });
      const h = M.geschenkHinweis({ name, email }, g);
      for (const to of advisorEmails()) mailSicher({ kind: 'geschenk_hinweis', to, subject: h.subject, text: h.text, senderName: 'RhetorIQ' });
      res.json({ ok: true, schon: false, titel: g.titel });
    } catch (e) { fehler500(res, e); }
  });

  return router;
}

const router = build();
router.build = build;
module.exports = router;
