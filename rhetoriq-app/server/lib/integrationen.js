// Anbindungen für KMU: Newsletter-Entwurf in Brevo oder Mailchimp, Blog-Entwurf in WordPress.
// Es wird NIE versendet oder veröffentlicht: Brevo und Mailchimp erhalten nur Entwürfe (keine Versand-Endpunkte),
// WordPress erhält Beiträge mit Status «draft». Zugangsdaten liegen verschlüsselt (lib/secretBox.js) und tauchen nie
// in Antworten, Logs oder Fehlermeldungen auf (lib/scrub.js). Die Adresse einer WordPress-Seite stammt von der Nutzerin
// und läuft deshalb nur über den geschützten Abruf (lib/safeFetch.js: kein Loopback, keine privaten Adressen, nur Port 443).
const https = require('https');
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const secretBox = require('./secretBox');
const { scrubText } = require('./scrub');
const { parseTarget, guardedLookup } = require('./safeFetch');
const { baueHtml } = require('./newsletterHtml');

const TIMEOUT_MS = 20000;
class IntFehler extends Error {
  constructor(code, message) { super(message); this.name = 'IntFehler'; this.code = code; }
}

// ── Transport (für Tests austauschbar) ────────────────────────────────────────
// req: { method, url, headers, body, sicher }  ->  { status, json }
async function echterTransport(req) {
  if (!req.sicher) {
    const r = await globalThis.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json = null; try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json };
  }
  return new Promise((resolve, reject) => {
    const u = new URL(req.url);
    const r = https.request(u, { method: req.method, headers: req.headers, lookup: guardedLookup, timeout: TIMEOUT_MS }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n <= 2 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } resolve({ status: res.statusCode || 0, json }); });
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (req.body) r.write(req.body);
    r.end();
  });
}
let transport = echterTransport;
function _setzeTransport(fn) { transport = fn || echterTransport; }

// Alle Geheimnisse einer Anfrage (Schlüssel im Header, Teile eines Basic-Zugangs), damit sie nie in einer Meldung landen
function geheimnisse(headers) {
  const out = new Set();
  for (const [k, v] of Object.entries(headers || {})) {
    const val = String(v || '');
    if (/^api-key$/i.test(k) && val.length >= 8) out.add(val);
    if (/^authorization$/i.test(k)) {
      const b = val.replace(/^Basic\s+/i, '');
      if (b.length >= 8) out.add(b);
      try { Buffer.from(b, 'base64').toString('utf8').split(':').forEach(p => { if (p.length >= 8) out.add(p); }); } catch { /* kein Basic-Wert */ }
    }
  }
  return [...out];
}
function ohneGeheimnisse(text, geheim) {
  let t = scrubText(String(text));
  for (const g of geheim) t = t.split(g).join('[Schlüssel entfernt]');
  return t;
}

async function anfrage(req, meldungen) {
  let r;
  try { r = await transport(req); } catch { throw new IntFehler('netz', meldungen.netz); }
  if (r.status >= 200 && r.status < 300) return r.json || {};
  if (r.status === 401 || r.status === 403) throw new IntFehler('ungueltig', meldungen.ungueltig);
  if (r.status === 429) throw new IntFehler('limit', meldungen.limit);
  if (r.status >= 500) throw new IntFehler('server', meldungen.server);
  const detail = r.json && (r.json.message || r.json.detail || r.json.title || (r.json.code && String(r.json.code)));
  throw new IntFehler('anfrage', `${meldungen.name} hat die Anfrage abgelehnt${detail ? ': ' + ohneGeheimnisse(detail, geheimnisse(req.headers)).slice(0, 200) : '.'}`);
}
function meldungen(name) {
  return {
    name,
    ungueltig: `Der Zugang zu ${name} ist ungültig oder wurde widerrufen. Bitte erstellen Sie einen neuen Schlüssel und tragen Sie ihn neu ein.`,
    limit: `${name} lässt gerade keine weiteren Anfragen zu. Bitte versuchen Sie es in einer Minute erneut.`,
    server: `${name} antwortet gerade nicht. Bitte versuchen Sie es später erneut.`,
    netz: `${name} ist nicht erreichbar. Bitte versuchen Sie es später erneut.`
  };
}

function absatzHtml(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = s => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const teile = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
  return teile.map(t => {
    const zeilen = t.split('\n');
    if (zeilen.every(z => /^\s*[-•]\s+/.test(z))) return '<ul>' + zeilen.map(z => '<li>' + inline(z.replace(/^\s*[-•]\s+/, '')) + '</li>').join('') + '</ul>';
    if (zeilen.length === 1 && zeilen[0].length < 90 && /^[A-ZÄÖÜ0-9][^.!?]*:?$/.test(zeilen[0]) && zeilen[0] === zeilen[0].toUpperCase()) return '<h2>' + inline(zeilen[0]) + '</h2>';
    return '<p>' + zeilen.map(inline).join('<br>') + '</p>';
  }).join('\n');
}

// ── Anbieter ──────────────────────────────────────────────────────────────────
const ANBIETER = {
  brevo: {
    label: 'Brevo', art: 'newsletter',
    felder: ['apiKey'],
    pruefeFormat: d => /^[A-Za-z0-9_-]{20,200}$/.test(String(d.apiKey || '').trim()),
    formatText: 'Das sieht nicht wie ein Brevo-Schlüssel aus. Er steht in Brevo unter SMTP und API, API-Schlüssel (v3).',
    kopf: d => ({ 'api-key': String(d.apiKey).trim(), 'accept': 'application/json', 'content-type': 'application/json' }),
    base: () => 'https://api.brevo.com/v3',
    async pruefe(d) { await anfrage({ method: 'GET', url: this.base() + '/account', headers: this.kopf(d) }, meldungen('Brevo')); },
    async listen(d) {
      const j = await anfrage({ method: 'GET', url: this.base() + '/contacts/lists?limit=50', headers: this.kopf(d) }, meldungen('Brevo'));
      return (j.lists || []).map(l => ({ id: String(l.id), name: l.name }));
    },
    async entwurf(d, { text, kampagne }) {
      const h = baueHtml(text, {});
      const betreff = h.betreff || 'Newsletter';
      const name = `${betreff.slice(0, 100)} (RhetorIQ ${new Date().toLocaleDateString('de-CH')})`;
      const j = await anfrage({
        method: 'POST', url: this.base() + '/emailCampaigns', headers: this.kopf(d),
        body: JSON.stringify({ name, subject: betreff, htmlContent: h.html, ...(h.vorschau ? { previewText: h.vorschau } : {}),
          sender: { name: kampagne.absenderName || kampagne.absenderEmail, email: kampagne.absenderEmail }, recipients: { listIds: [parseInt(kampagne.listId, 10)] } })
      }, meldungen('Brevo'));
      return { id: String(j.id || ''), name, hinweis: 'In Brevo liegt jetzt ein Newsletter-Entwurf unter Kampagnen. Es wurde nichts versendet. Den Versand lösen Sie in Brevo selbst aus.' };
    },
    listeNoetig: true
  },
  mailchimp: {
    label: 'Mailchimp', art: 'newsletter',
    felder: ['apiKey'],
    pruefeFormat: d => /^[a-f0-9]{32}-[a-z]{2,3}\d{1,2}$/.test(String(d.apiKey || '').trim()),
    formatText: 'Das sieht nicht wie ein Mailchimp-Schlüssel aus. Er hat 32 Zeichen, einen Bindestrich und eine Endung wie us21 (Mailchimp, Account, Extras, API keys).',
    base: d => `https://${String(d.apiKey).trim().split('-').pop()}.api.mailchimp.com/3.0`,
    kopf: d => ({ 'authorization': 'Basic ' + Buffer.from('rhetoriq:' + String(d.apiKey).trim()).toString('base64'), 'accept': 'application/json', 'content-type': 'application/json' }),
    async pruefe(d) { await anfrage({ method: 'GET', url: this.base(d) + '/ping', headers: this.kopf(d) }, meldungen('Mailchimp')); },
    async listen(d) {
      const j = await anfrage({ method: 'GET', url: this.base(d) + '/lists?count=50&fields=lists.id,lists.name', headers: this.kopf(d) }, meldungen('Mailchimp'));
      return (j.lists || []).map(l => ({ id: String(l.id), name: l.name }));
    },
    async entwurf(d, { text, kampagne }) {
      const h = baueHtml(text, {});
      const betreff = h.betreff || 'Newsletter';
      const name = `${betreff.slice(0, 100)} (RhetorIQ ${new Date().toLocaleDateString('de-CH')})`;
      const m = meldungen('Mailchimp');
      const c = await anfrage({
        method: 'POST', url: this.base(d) + '/campaigns', headers: this.kopf(d),
        body: JSON.stringify({ type: 'regular', recipients: { list_id: String(kampagne.listId) },
          settings: { subject_line: betreff, title: name, ...(h.vorschau ? { preview_text: h.vorschau } : {}), from_name: kampagne.absenderName || kampagne.absenderEmail, reply_to: kampagne.absenderEmail } })
      }, m);
      await anfrage({ method: 'PUT', url: this.base(d) + `/campaigns/${encodeURIComponent(c.id)}/content`, headers: this.kopf(d), body: JSON.stringify({ html: h.html }) }, m);
      return { id: String(c.id || ''), name, hinweis: 'In Mailchimp liegt jetzt ein Kampagnenentwurf. Es wurde nichts versendet. Den Versand lösen Sie in Mailchimp selbst aus.' };
    },
    listeNoetig: true
  },
  wordpress: {
    label: 'WordPress', art: 'blog',
    felder: ['site', 'user', 'apiKey'],
    pruefeFormat: d => !!d.user && String(d.user).length <= 100 && /^[A-Za-z0-9 ]{16,80}$/.test(String(d.apiKey || '').trim()) && (() => { try { return parseTarget(d.site).protocol === 'https:'; } catch { return false; } })(),
    formatText: 'Bitte tragen Sie die Adresse Ihrer Webseite (mit https), Ihren Benutzernamen und ein Anwendungspasswort ein (WordPress, Benutzer, Profil, Anwendungspasswörter).',
    basis: d => { const u = parseTarget(d.site); return (u.origin + u.pathname).replace(/\/+$/, ''); },
    kopf: d => ({ 'authorization': 'Basic ' + Buffer.from(`${String(d.user).trim()}:${String(d.apiKey).trim()}`).toString('base64'), 'accept': 'application/json', 'content-type': 'application/json' }),
    async pruefe(d) { await anfrage({ method: 'GET', url: this.basis(d) + '/wp-json/wp/v2/users/me?context=edit', headers: this.kopf(d), sicher: true }, meldungen('WordPress')); },
    async entwurf(d, { text }) {
      const zeilen = String(text || '').replace(/\r\n?/g, '\n').split('\n');
      let i = 0; while (i < zeilen.length && !zeilen[i].trim()) i++;
      let titel = (zeilen[i] || '').replace(/\*\*/g, '').replace(/^\s*(Titel|Title|Betreff|Überschrift)\s*:\s*/i, '').trim();
      const kurz = titel.length > 0 && titel.length <= 120;
      const rest = kurz ? zeilen.slice(i + 1).join('\n') : String(text || '');
      if (!kurz) titel = 'Entwurf aus RhetorIQ';
      const j = await anfrage({
        method: 'POST', url: this.basis(d) + '/wp-json/wp/v2/posts', headers: this.kopf(d), sicher: true,
        body: JSON.stringify({ title: titel, content: absatzHtml(rest), status: 'draft' })
      }, meldungen('WordPress'));
      return { id: String(j.id || ''), name: titel, hinweis: 'In WordPress liegt jetzt ein Entwurf unter Beiträge. Er ist nicht veröffentlicht. Die Veröffentlichung lösen Sie in WordPress selbst aus.' };
    },
    listeNoetig: false
  }
};
function anbieter(name) { return Object.prototype.hasOwnProperty.call(ANBIETER, name) ? ANBIETER[name] : null; }

// ── Ablage der Zugangsdaten und Voreinstellungen ──────────────────────────────
async function speichere(clientId, name, daten) {
  await ensureSchema();
  const enc = secretBox.encrypt(JSON.stringify(daten));
  const up = await pool.query('UPDATE integration_zugang SET secret_enc=$3, geprueft_am=NOW(), updated_at=NOW() WHERE client_id=$1 AND anbieter=$2', [clientId, name, enc]);
  if (!up.rowCount) await pool.query('INSERT INTO integration_zugang (client_id, anbieter, secret_enc, geprueft_am) VALUES ($1,$2,$3,NOW())', [clientId, name, enc]);
}
async function lade(clientId, name) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT secret_enc FROM integration_zugang WHERE client_id=$1 AND anbieter=$2', [clientId, name]);
  if (!rows[0]) return null;
  try { return JSON.parse(secretBox.decrypt(rows[0].secret_enc)); } catch { return null; }
}
async function loesche(clientId, name) {
  await ensureSchema();
  await pool.query('DELETE FROM integration_zugang WHERE client_id=$1 AND anbieter=$2', [clientId, name]);
  await pool.query('DELETE FROM integration_voreinstellung WHERE client_id=$1 AND anbieter=$2', [clientId, name]);
}
async function verbundene(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT anbieter FROM integration_zugang WHERE client_id=$1', [clientId]);
  return rows.map(r => r.anbieter);
}
async function voreinstellung(clientId, name) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT daten FROM integration_voreinstellung WHERE client_id=$1 AND anbieter=$2', [clientId, name]);
  if (!rows[0]) return null;
  try { return typeof rows[0].daten === 'string' ? JSON.parse(rows[0].daten) : rows[0].daten; } catch { return null; }
}
async function merkeVoreinstellung(clientId, name, k) {
  const daten = JSON.stringify({ listId: String(k.listId).trim(), absenderEmail: String(k.absenderEmail).trim(), absenderName: String(k.absenderName || '').slice(0, 100) });
  const up = await pool.query('UPDATE integration_voreinstellung SET daten=$3, updated_at=NOW() WHERE client_id=$1 AND anbieter=$2', [clientId, name, daten]);
  if (!up.rowCount) await pool.query('INSERT INTO integration_voreinstellung (client_id, anbieter, daten) VALUES ($1,$2,$3)', [clientId, name, daten]);
}

const LISTE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
function kampagneGueltig(k) { return !!k && typeof k === 'object' && LISTE_RE.test(String(k.listId || '').trim()) && MAIL_RE.test(String(k.absenderEmail || '').trim()); }

// Legt den Entwurf an. Wirft IntFehler.
async function entwurfAnlegen(clientId, name, { text, kampagne, reviewId = null }) {
  const a = anbieter(name);
  const daten = await lade(clientId, name);
  if (!a || !daten) throw new IntFehler('nichtVerbunden', `${a ? a.label : 'Der Dienst'} ist noch nicht verbunden.`);
  const out = await a.entwurf(daten, { text, kampagne });
  await pool.query('INSERT INTO integration_uebertragungen (client_id, anbieter, review_id, externe_id) VALUES ($1,$2,$3,$4)', [clientId, name, reviewId, out.id || null]);
  return { ok: true, ...out };
}

module.exports = { ANBIETER, anbieter, IntFehler, speichere, lade, loesche, verbundene, voreinstellung, merkeVoreinstellung, kampagneGueltig, entwurfAnlegen, _setzeTransport, absatzHtml };
