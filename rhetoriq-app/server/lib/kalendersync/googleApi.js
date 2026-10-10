// Google Kalender: OAuth (Autorisierungscode mit PKCE) und die Aufrufe der Kalender-API.
// Zugangsdaten: GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET aus der Umgebung. Sie und alle Tokens werden nie geloggt und nie in Fehlertexte übernommen.
// Das Refresh-Token liegt nur verschlüsselt in der Datenbank (lib/secretBox.js). Der Zugriffstoken lebt nur im Arbeitsspeicher.
// Scope nur calendar.app.created: die App sieht und ändert ausschliesslich Kalender, die sie selbst angelegt hat.
const crypto = require('crypto');
const secretBox = require('../secretBox');
const { scrubText } = require('../scrub');
const KD = require('./daten');

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

// Austauschbar für Tests: Netz und Wartezeit
const http = { fetch: (...a) => globalThis.fetch(...a), sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
function _setHttp(o) { Object.assign(http, o); }

class GoogleFehler extends Error {
  constructor(msg, { status = 0, code = '' } = {}) { super(msg); this.name = 'GoogleFehler'; this.status = status; this.code = code; }
}

const clientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = () => String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
const konfiguriert = () => !!(clientId() && clientSecret());
const appUrl = () => (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const redirectUri = () => `${appUrl()}/api/kalender/google/callback`;
const webhookUrl = () => `${appUrl()}/api/kalender/google/webhook`;
const webhookMoeglich = () => /^https:\/\//i.test(appUrl());

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
function autorisierungsUrl(state, challenge) {
  const q = new URLSearchParams({
    client_id: clientId(), redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
    code_challenge: challenge, code_challenge_method: 'S256'
  });
  return `${AUTH_URL}?${q.toString()}`;
}

// Fehlertext ohne Geheimnisse
function sauber(t) {
  let s = scrubText(t);
  for (const g of [clientSecret(), clientId()]) if (g && g.length >= 8) s = s.split(g).join('[entfernt]');
  return s.replace(/\b(ya29\.|1\/\/)[A-Za-z0-9._~+\/-]{10,}/g, '[entfernt]').slice(0, 300);
}
async function jsonVon(r) { try { return await r.json(); } catch { return null; } }

async function tokenAnfrage(felder) {
  const body = new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...felder });
  let r;
  try { r = await http.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }); }
  catch (e) { throw new GoogleFehler('Google ist nicht erreichbar.', { code: 'netz' }); }
  const j = await jsonVon(r);
  if (!r.ok) {
    const code = (j && j.error) || 'fehler';
    throw new GoogleFehler(code === 'invalid_grant' ? 'Die Verbindung zu Google ist abgelaufen. Bitte verbinde neu.' : `Google hat die Anmeldung abgelehnt (${sauber(code)}).`, { status: r.status, code });
  }
  return j || {};
}
async function codeTauschen(code, verifier) {
  return tokenAnfrage({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
}

const zwischenspeicher = new Map(); // advisorId -> { token, bis }
async function zugriffstoken(aid, { frisch = false } = {}) {
  const z = zwischenspeicher.get(aid);
  if (!frisch && z && z.bis > Date.now() + 60000) return z.token;
  const row = await KD.googleZeile(aid);
  if (!row) throw new GoogleFehler('Google ist nicht verbunden.', { code: 'nicht_verbunden' });
  let refresh;
  try { refresh = secretBox.decrypt(row.refresh_enc); }
  catch { throw new GoogleFehler('Der gespeicherte Google-Zugang ist nicht lesbar. Bitte verbinde neu.', { code: 'schluessel' }); }
  const j = await tokenAnfrage({ grant_type: 'refresh_token', refresh_token: refresh });
  if (!j.access_token) throw new GoogleFehler('Google hat keinen Zugriff erteilt.', { code: 'kein_token' });
  zwischenspeicher.set(aid, { token: j.access_token, bis: Date.now() + (Number(j.expires_in) || 3000) * 1000 });
  return j.access_token;
}
function tokenVergessen(aid) { zwischenspeicher.delete(aid); }

async function widerrufen(token) {
  try {
    const r = await http.fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
    return r.ok;
  } catch { return false; }
}

const WIEDERHOLBAR_403 = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError'];
function wartezeit(versuch, r) {
  const ra = r && r.headers && r.headers.get ? Number(r.headers.get('retry-after')) : NaN;
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra, 60) * 1000;
  return Math.min(32000, 1000 * 2 ** versuch) + Math.floor(Math.random() * 500);
}
// Allgemeiner Aufruf mit Wiederholung bei 429, 5xx und Ratenlimit-403 (Backoff) und einmaliger Erneuerung des Zugriffstokens bei 401.
// erlaubt: Statuscodes, die ohne Fehler zurückgegeben werden (zum Beispiel 404 oder 410)
async function api(aid, methode, pfad, { query, body, erlaubt = [], url, versuche = 5 } = {}) {
  let erneuert = false;
  for (let n = 0; ; n++) {
    const token = await zugriffstoken(aid);
    const u = new URL(url || API + pfad);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    let r;
    try {
      r = await http.fetch(u.toString(), { method: methode, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (n + 1 < versuche) { await http.sleep(wartezeit(n)); continue; }
      throw new GoogleFehler('Google ist nicht erreichbar.', { code: 'netz' });
    }
    const status = r.status;
    if (status === 401 && !erneuert) { erneuert = true; tokenVergessen(aid); continue; }
    if (status >= 200 && status < 300) return { status, json: status === 204 ? null : await jsonVon(r), etag: r.headers && r.headers.get ? r.headers.get('etag') : null };
    const j = await jsonVon(r);
    const grund = j && j.error && Array.isArray(j.error.errors) && j.error.errors[0] ? j.error.errors[0].reason : '';
    if (erlaubt.includes(status)) return { status, json: j };
    const wiederholbar = status === 429 || status >= 500 || (status === 403 && WIEDERHOLBAR_403.includes(grund));
    if (wiederholbar && n + 1 < versuche) { await http.sleep(wartezeit(n, r)); continue; }
    const code = grund || (j && j.error && j.error.status) || String(status);
    throw new GoogleFehler(`Google antwortet mit Status ${status} (${sauber(code)}).`, { status, code: String(code) });
  }
}

// ── Kalender und Ereignisse ──
const kalenderAnlegen = (aid) => api(aid, 'POST', '/calendars', { body: { summary: 'RhetorIQ', description: 'Tagesplan und Termine aus RhetorIQ', timeZone: 'Europe/Zurich' } }).then(r => r.json);
const kalenderPruefen = (aid, id) => api(aid, 'GET', `/calendars/${encodeURIComponent(id)}`, { erlaubt: [404, 410] });
const ereignisEinfuegen = (aid, cal, body) => api(aid, 'POST', `/calendars/${encodeURIComponent(cal)}/events`, { body, erlaubt: [409] });
const ereignisErsetzen = (aid, cal, eid, body) => api(aid, 'PUT', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eid)}`, { body, erlaubt: [404, 410] });
const ereignisAendern = (aid, cal, eid, body) => api(aid, 'PATCH', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eid)}`, { body, erlaubt: [404, 410] });
const ereignisLoeschen = (aid, cal, eid) => api(aid, 'DELETE', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eid)}`, { erlaubt: [404, 410] });
const ereignisListe = (aid, cal, query) => api(aid, 'GET', `/calendars/${encodeURIComponent(cal)}/events`, { query, erlaubt: [410] });
const beobachten = (aid, cal, body) => api(aid, 'POST', `/calendars/${encodeURIComponent(cal)}/events/watch`, { body });
const kanalStoppen = (aid, body) => api(aid, 'POST', '/channels/stop', { body, erlaubt: [404] });

module.exports = {
  SCOPE, GoogleFehler, konfiguriert, redirectUri, webhookUrl, webhookMoeglich, appUrl, pkce, autorisierungsUrl, codeTauschen, zugriffstoken, tokenVergessen, widerrufen,
  api, kalenderAnlegen, kalenderPruefen, ereignisEinfuegen, ereignisErsetzen, ereignisAendern, ereignisLoeschen, ereignisListe, beobachten, kanalStoppen, sauber, _setHttp
};
