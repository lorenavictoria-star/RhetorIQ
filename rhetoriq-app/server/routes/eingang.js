// Eingang der Beraterin und Mail-Empfang.
//  GET  /api/assistent/eingang                    Beraterin: { zaehler, eintraege } (höchstens 50, neueste zuerst)
//  POST /api/assistent/eingang/mail/:id/gelesen   Beraterin: Mail als gelesen markieren
//  POST /api/eingang/mail                         Zustelldienst: nimmt eine Mail an, geschützt mit Header x-eingang-token
//
// Mail-Empfang. Die Zustellung (Brevo Inbound Parsing, Gmail-Weiterleitung oder IMAP) richtet die Beraterin später ein.
// Render-Variable: EINGANG_MAIL_SECRET (ohne sie antwortet der Endpunkt mit 503), optional EINGANG_MAIL_ADRESSE
// (Standard contact@lorenalienhard.ch; nur Mails an diese Adresse werden gespeichert).
// Erwartetes JSON (höchstens 300 KB):
//   { "von": "Anna Muster <anna@firma.ch>", "an": "contact@lorenalienhard.ch", "betreff": "Frage zum Workshop",
//     "text": "Reiner Text der Mail", "html": "<p>Alternativ HTML, wenn kein text da ist</p>", "message_id": "<abc@mail.firma.ch>" }
// "an" darf auch eine Liste oder ein Objekt { address, name } sein. Gespeichert werden nur Absender, Betreff und ein
// Auszug von höchstens 300 Zeichen (reiner Text, HTML entfernt). Doppelte message_id werden ignoriert.
const crypto = require('crypto');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const E = require('../lib/eingang');

const MAX_BYTES = 300 * 1024;
const zielAdresse = () => String(process.env.EINGANG_MAIL_ADRESSE || 'contact@lorenalienhard.ch').trim().toLowerCase();

function gleich(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function build(opts = {}) {
  const { mailMax = 60, jetzt = () => new Date() } = opts;
  const advisorRouter = express.Router();
  const mailRouter = express.Router();

  const lesenLimit = rateLimit({
    windowMs: 60 * 1000, max: 60, keyGenerator: (req) => 'eg_' + ((req.user && req.user.id) || 'x'), validate: { keyGeneratorIpFallback: false },
    standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
  });
  advisorRouter.use(requireAdvisor, lesenLimit);

  advisorRouter.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await E.eingang(req.user.id, jetzt()));
    } catch (e) {
      console.error('[eingang]', e && e.message);
      res.status(500).json({ error: 'Der Eingang konnte nicht geladen werden. Bitte versuche es gleich noch einmal.' });
    }
  });

  advisorRouter.post('/mail/:id/gelesen', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Nummer.' });
      if (!(await E.mailGelesen(id))) return res.status(404).json({ error: 'Mail nicht gefunden.' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[eingang]', e && e.message);
      res.status(500).json({ error: 'Das hat nicht geklappt. Bitte versuche es noch einmal.' });
    }
  });

  const mailLimit = rateLimit({
    windowMs: 60 * 1000, max: mailMax, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: true, legacyHeaders: false,
    message: { error: 'Zu viele Anfragen.' }
  });
  mailRouter.post('/mail', mailLimit, express.json({ limit: MAX_BYTES }), async (req, res) => {
    try {
      const secret = process.env.EINGANG_MAIL_SECRET;
      if (!secret) return res.status(503).json({ error: 'Mail-Empfang ist nicht eingerichtet.' });
      if (!gleich(req.get('x-eingang-token') || '', secret)) return res.status(401).json({ error: 'Nicht erlaubt.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      if (!body) return res.status(400).json({ error: 'JSON erwartet.' });
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) return res.status(413).json({ error: 'Zu gross.' });
      if (body.von == null || body.an == null) return res.status(400).json({ error: 'Felder von und an fehlen.' });
      const r = await E.mailSpeichern(body, zielAdresse(), jetzt());
      res.json({ ok: true, gespeichert: r.gespeichert, ...(r.grund ? { grund: r.grund } : {}) });
    } catch (e) {
      console.error('[eingang] Mail-Empfang:', e && e.message);
      res.status(500).json({ error: 'Das hat nicht geklappt.' });
    }
  });

  return { advisorRouter, mailRouter };
}

const def = build();
module.exports = { build, advisorRouter: def.advisorRouter, mailRouter: def.mailRouter };
