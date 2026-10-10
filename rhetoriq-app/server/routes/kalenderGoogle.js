// Google Kalender verbinden (nur Rolle advisor), Rückmeldungen von Google (Webhook) und Abgleich.
//  GET    /api/kalender/google/status        Zustand der Verbindung, ohne Geheimnisse
//  POST   /api/kalender/google/verbinden     startet die Anmeldung bei Google, liefert die Adresse
//  GET    /api/kalender/google/callback      öffentlich: Weiterleitung von Google (state einmalig, an Sitzung und Browser gebunden)
//  POST   /api/kalender/google/sync          jetzt abgleichen (lesen und schreiben); leise: nur wenn der letzte Abgleich länger her ist
//  POST   /api/kalender/google/trennen       widerruft das Token bei Google und löscht es lokal
//  DELETE /api/kalender/google/ausgeblendet  am Handy gelöschte Plan-Aufgaben für heute wieder einblenden
//  POST   /api/kalender/google/webhook       öffentlich, geprüft mit Kanal-ID und Kanal-Token
// Tokens, Codes und der state erscheinen nie in Antworten oder Logs.
const express = require('express');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requireAdvisor } = require('../middleware/auth');
const secretBox = require('../lib/secretBox');
const KD = require('../lib/kalendersync/daten');
const G = require('../lib/kalendersync/googleApi');
const google = require('../lib/kalendersync/google');
const Z = require('../lib/zeit');

const router = express.Router();
const COOKIE = 'rq_gs';
const NICHT_EINGERICHTET = 'Google-Zugang ist noch nicht eingerichtet';
const EINRICHTUNG = 'Lorena legt bei Google Cloud einen OAuth-Client an (Typ Webanwendung, Weiterleitungs-URI siehe unten) und trägt GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET bei Render ein.';

const cookieWert = (req) => {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]+)').exec(String(req.headers.cookie || ''));
  return m ? m[1] : '';
};
const weiter = (res, code) => res.redirect(302, `${G.appUrl()}/?google=${code}`);
const clearCookie = (res) => res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/api/kalender/google; HttpOnly; SameSite=Lax${G.appUrl().startsWith('https') ? '; Secure' : ''}`);

// ── Öffentlich ──
const callbackLimit = rateLimit({ windowMs: 60 * 1000, max: 30, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: true, legacyHeaders: false, message: 'Zu viele Anfragen.' });
router.get('/callback', callbackLimit, async (req, res) => {
  clearCookie(res);
  try {
    const { code, state, error } = req.query;
    // Der Zustand wird in jedem Fall eingelöst und ist danach verbraucht
    const z = await KD.stateEinloesen(typeof state === 'string' ? state : '', cookieWert(req));
    if (!z) return weiter(res, 'zustand');
    if (error) return weiter(res, error === 'access_denied' ? 'abgelehnt' : 'fehler');
    if (typeof code !== 'string' || !code || code.length > 2048) return weiter(res, 'fehler');
    let verifier;
    try { verifier = secretBox.decrypt(z.verifierEnc); } catch { return weiter(res, 'schluessel'); }
    await google.verbindungHerstellen(z.advisorId, code, verifier);
    google.synchronisiere(z.advisorId, { voll: true }).catch(e => console.error('[kalender-google] erster Abgleich fehlgeschlagen:', G.sauber(e.message)));
    return weiter(res, 'verbunden');
  } catch (e) {
    console.error('[kalender-google] Verbindung fehlgeschlagen:', G.sauber(e && e.message));
    return weiter(res, e && e.code === 'NO_SECRET' ? 'schluessel' : e && e.code === 'kein_refresh' ? 'dauerzugriff' : e && e.code === 'scope' ? 'berechtigung' : 'fehler');
  }
});

const webhookLimit = rateLimit({ windowMs: 60 * 1000, max: 600, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: false, legacyHeaders: false, message: 'Zu viele Anfragen.' });
router.post('/webhook', webhookLimit, async (req, res) => {
  try {
    const row = await google.webhookPruefen(req.get('x-goog-channel-id'), req.get('x-goog-channel-token'));
    if (!row) return res.status(404).end();
    const zustand = String(req.get('x-goog-resource-state') || '').toLowerCase();
    if (zustand === 'sync') return res.status(200).end(); // Bestätigung nach dem Anlegen des Kanals
    if (zustand === 'exists' || zustand === 'not_exists') google.lesenEinplanen(row.advisor_id);
    res.status(200).end();
  } catch (e) {
    console.error('[kalender-google] Webhook fehlgeschlagen:', G.sauber(e && e.message));
    res.status(200).end();
  }
});

// ── Beraterin ──
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'kg_' + ((req.user && req.user.id) || 'x'), validate: { keyGeneratorIpFallback: false },
  message: { error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.' }
});
router.use(requireAdvisor, limiter);

function fail(res, e) {
  console.error('[kalender-google]', G.sauber(e && e.message));
  res.status(500).json({ error: 'Das hat nicht geklappt. Bitte versuche es gleich noch einmal.' });
}

router.get('/status', async (req, res) => {
  try {
    const row = await KD.googleZeile(req.user.id);
    res.json({
      konfiguriert: G.konfiguriert(), schluesselOk: secretBox.available(), redirectUri: G.redirectUri(),
      hinweis: G.konfiguriert() ? null : `${NICHT_EINGERICHTET}. ${EINRICHTUNG}`,
      verbunden: !!(row && row.calendar_id), letzteSync: row ? row.letzte_sync : null, fehler: row ? row.fehler : null, fehlerSeit: row ? row.fehler_seit : null,
      kanalBis: row ? row.channel_ablauf : null, ausgeblendet: (await KD.ausgeblendetAm(req.user.id, Z.heute())).size
    });
  } catch (e) { fail(res, e); }
});

router.post('/verbinden', async (req, res) => {
  try {
    if (!G.konfiguriert()) return res.status(503).json({ error: NICHT_EINGERICHTET, hinweis: EINRICHTUNG, redirectUri: G.redirectUri() });
    if (!secretBox.available()) return res.status(503).json({ error: 'Die Verschlüsselung ist noch nicht eingerichtet (SECRETS_ENCRYPTION_KEY). Es wird nichts gespeichert.' });
    const state = crypto.randomBytes(32).toString('base64url');
    const bindung = crypto.randomBytes(32).toString('base64url');
    const { verifier, challenge } = G.pkce();
    await KD.stateAnlegen(req.user.id, state, bindung, secretBox.encrypt(verifier));
    res.append('Set-Cookie', `${COOKIE}=${bindung}; Max-Age=600; Path=/api/kalender/google; HttpOnly; SameSite=Lax${G.appUrl().startsWith('https') ? '; Secure' : ''}`);
    res.json({ url: G.autorisierungsUrl(state, challenge) });
  } catch (e) { fail(res, e); }
});

router.post('/sync', async (req, res) => {
  try {
    const row = await KD.googleZeile(req.user.id);
    if (!row || !row.calendar_id) return res.status(409).json({ error: 'Google ist nicht verbunden.' });
    const leise = !!(req.body && req.body.leise);
    if (leise && row.letzte_sync && Date.now() - new Date(row.letzte_sync).getTime() < 30000) return res.json({ ok: true, uebersprungen: true, geaendert: 0 });
    const r = await google.synchronisiere(req.user.id, { voll: !!(req.body && req.body.voll) });
    res.json(r);
  } catch (e) { fail(res, e); }
});

router.post('/trennen', async (req, res) => {
  try {
    const r = await google.trennen(req.user.id);
    res.json({ ok: true, widerrufen: r.widerrufen });
  } catch (e) { fail(res, e); }
});

router.delete('/ausgeblendet', async (req, res) => {
  try { res.json({ ok: true, eingeblendet: await KD.einblendenAlle(req.user.id, Z.heute()) }); } catch (e) { fail(res, e); }
});

module.exports = router;
