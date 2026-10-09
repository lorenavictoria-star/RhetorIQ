// Klaviyo-Anbindung für Klienten: verschlüsselte serverseitige Ablage, Schlüssel erscheint nie in Antworten, Logs oder Fehlern,
// Aufrufe an Klaviyo sind gemockt, es wird nie versendet.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('../test-support/harness');
const { pool } = H;

const KEY = 'pk_' + 'Zt9Qw3Lm7Xc2Vb8Nk4Jh6Gf1Ds5Aa0Pq';   // Testwert, kein echter Schlüssel
const MASTER = crypto.randomBytes(32).toString('hex');
const realFetch = globalThis.fetch;
const calls = [];
let kv = {};
const logs = [];
const origLog = { log: console.log, error: console.error, warn: console.warn };

function antwort(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const c = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
  calls.push(c);
  if (kv.netz) throw new Error(`Netzfehler mit ${KEY}`);
  const p = c.url.replace('https://a.klaviyo.com', '');
  if (kv.status) return antwort(kv.status, { errors: [{ detail: `Detail mit ${KEY}` }] });
  if (p.startsWith('/api/templates/?') && c.method === 'GET') return antwort(kv.templatesStatus || 200, { data: [{ id: 'T0', attributes: { name: 'Alt', html: '<p>x</p>' } }] });
  if (p.startsWith('/api/lists/?')) return antwort(kv.listsStatus || 200, { data: [{ id: 'LIST1', attributes: { name: 'Hauptliste' } }] });
  if (p.startsWith('/api/campaigns/?')) return antwort(kv.campaignsStatus || 200, { data: [] });
  if (p === '/api/templates/' && c.method === 'POST') return antwort(kv.templatePostStatus || 201, { data: { id: 'TPL1' } });
  if (p === '/api/campaigns/' && c.method === 'POST') return kv.campaignPostStatus ? antwort(kv.campaignPostStatus, { errors: [{ detail: 'Absender nicht verifiziert' }] }) : antwort(201, { data: { id: 'CAM1', relationships: { 'campaign-messages': { data: [{ id: 'MSG1' }] } } } });
  if (p === '/api/campaign-message-assign-template/') return antwort(200, { data: { id: 'MSG1' } });
  return antwort(404, { errors: [{ detail: 'unbekannt' }] });
};
for (const k of ['log', 'error', 'warn']) console[k] = (...a) => { logs.push(a.map(x => (x && x.stack) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };

let srv, a, b, tm = {}, rvOk, rvOffen, rvFremd;
const tok = (role) => H.clientToken(a.id, { clientUserId: tm[role], clientUserRole: role });
const call = (m, u, o) => srv.call(m, u, o);
const gespeichert = async () => (await pool.query('SELECT * FROM klaviyo_zugang')).rows;

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN included_minutes INTEGER').catch(() => {});
  await pool.query('ALTER TABLE review_requests ADD COLUMN module_tile TEXT').catch(() => {});
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  a = await H.addClient('Klaviyo AG'); b = await H.addClient('Fremd AG');
  await require('../lib/schemaRedesign').ensureSchema();
  for (const role of ['admin', 'editor', 'viewer']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@k.ch', role, role])).rows[0].id;
  const ins = (cid, status, edited, label = 'Newsletter-Entwurf') => pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, edited_text, status) VALUES ($1,$2,'themenplan',$3,$4,$5) RETURNING id`, [cid, label, edited || 'x', edited, status]).then(r => r.rows[0].id);
  const text = 'BETREFF: Herbst <in> der Praxis\nVORSCHAU: Kurz & knapp\n\nLiebe Leserin,\n\n## Neuigkeiten\n\nText mit <script>alert(1)</script> und **fett**.\n\n- Punkt\n\nHerzliche Grüsse';
  rvOk = await ins(a.id, 'approved', text);
  rvOffen = await ins(a.id, 'pending', text);
  rvFremd = await ins(b.id, 'approved', text);
  srv = await H.startApp([['/api/klaviyo', require('../routes/klaviyo')]]);
});
test.after(async () => { await srv.close(); globalThis.fetch = realFetch; Object.assign(console, origLog); });

test('Ohne SECRETS_ENCRYPTION_KEY: meldet sauber, speichert nichts', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  const n0 = calls.length;
  const r = await call('PUT', `/api/klaviyo/schluessel/${a.id}`, { token: tok('admin'), body: { apiKey: KEY } });
  assert.equal(r.status, 503);
  assert.equal(r.body.nichtEingerichtet, true);
  assert.match(r.body.error, /noch nicht eingerichtet/);
  assert.ok(!JSON.stringify(r.body).includes(KEY));
  assert.equal((await gespeichert()).length, 0);
  assert.equal(calls.length, n0, 'ohne Verschlüsselung geht der Schlüssel nirgends hin');
  const st = await call('GET', `/api/klaviyo/status/${a.id}`, { token: tok('viewer') });
  assert.equal(st.body.konfiguriert, false);
  assert.equal(st.body.verbunden, false);
});

test('secretBox: AES-256-GCM, jede Verschlüsselung anders, Manipulation und falscher Schlüssel scheitern', () => {
  const sb = require('../lib/secretBox');
  process.env.SECRETS_ENCRYPTION_KEY = 'zu kurz';
  assert.equal(sb.available(), false, 'ungültiger Hauptschlüssel zählt als nicht eingerichtet');
  assert.throws(() => sb.encrypt('x'), e => e.code === 'NO_SECRET');
  process.env.SECRETS_ENCRYPTION_KEY = MASTER;
  assert.equal(sb.available(), true);
  const e1 = sb.encrypt(KEY), e2 = sb.encrypt(KEY);
  assert.notEqual(e1, e2);
  assert.ok(!e1.includes(KEY) && e1.startsWith('v1.'));
  assert.equal(sb.decrypt(e1), KEY);
  const teile = e1.split('.');
  teile[3] = Buffer.from('manipuliert').toString('base64url');
  assert.throws(() => sb.decrypt(teile.join('.')), e => e.code === 'BAD_SECRET');
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  assert.throws(() => sb.decrypt(e1), e => e.code === 'BAD_SECRET');
  process.env.SECRETS_ENCRYPTION_KEY = MASTER;
});

test('Schlüssel eintragen: nur Rolle admin des eigenen Klienten, Prüfung vor dem Speichern, verschlüsselt abgelegt', async () => {
  const put = (token, key, id = a.id) => call('PUT', `/api/klaviyo/schluessel/${id}`, { token, body: { apiKey: key } });
  assert.equal((await put(tok('viewer'), KEY)).status, 403);
  assert.equal((await put(tok('editor'), KEY)).status, 403);
  assert.equal((await put(H.clientToken(b.id), KEY, a.id)).status, 403, 'fremder Klient');
  assert.equal((await put(H.clientToken(a.id, { readOnly: true }), KEY)).status, 403);
  const n0 = calls.length;
  const f = await put(tok('admin'), 'abc123');
  assert.equal(f.status, 400);
  assert.match(f.body.error, /kein privater Klaviyo-Schlüssel/);
  assert.equal(calls.length, n0, 'falsches Format geht gar nicht erst zu Klaviyo');
  kv = { status: 401 };
  const ung = await put(tok('admin'), KEY);
  assert.equal(ung.status, 400);
  assert.match(ung.body.error, /ungültig oder wurde widerrufen/);
  assert.equal((await gespeichert()).length, 0, 'ungültiger Schlüssel wird nicht gespeichert');
  assert.ok(!JSON.stringify(ung.body).includes(KEY));
  kv = {};
  const ok = await put(tok('admin'), KEY);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verbunden, true);
  assert.deepEqual(ok.body.rechte, { vorlagen: true, listen: true, kampagnen: true });
  assert.ok(!JSON.stringify(ok.body).includes(KEY));
  const rows = await gespeichert();
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].key_enc.includes(KEY), 'in der Datenbank steht nur Geheimtext');
  assert.ok(rows[0].key_enc.startsWith('v1.'));
});

test('Status zeigt nur «verbunden», nie den Schlüssel; fremde Klienten sehen nichts', async () => {
  const st = await call('GET', `/api/klaviyo/status/${a.id}`, { token: tok('editor') });
  assert.equal(st.status, 200);
  assert.equal(st.body.verbunden, true);
  assert.equal(st.body.konfiguriert, true);
  assert.ok(!JSON.stringify(st.body).includes(KEY));
  assert.ok(!('apiKey' in st.body) && !('key_enc' in st.body));
  assert.equal((await call('GET', `/api/klaviyo/status/${a.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await call('GET', `/api/klaviyo/status/${b.id}`, { token: tok('admin') })).status, 403);
});

test('Verbindung prüfen: Rechte, fehlende Rechte und Limit verständlich auf Deutsch', async () => {
  const pr = () => call('POST', `/api/klaviyo/pruefen/${a.id}`, { token: tok('admin'), body: {} });
  kv = {};
  let r = await pr();
  assert.equal(r.body.verbunden, true);
  assert.match(r.body.meldung, /alle Rechte/);
  kv = { campaignsStatus: 403 };
  r = await pr();
  assert.equal(r.body.verbunden, true);
  assert.equal(r.body.rechte.kampagnen, false);
  assert.match(r.body.meldung, /fehlen Rechte für: Campaigns/);
  kv = { status: 429 };
  r = await pr();
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Limit erreicht/);
  kv = { status: 401 };
  r = await pr();
  assert.equal(r.body.verbunden, false);
  assert.equal(r.body.ungueltig, true);
  kv = {};
  assert.equal((await call('POST', `/api/klaviyo/pruefen/${a.id}`, { token: tok('editor'), body: {} })).status, 403);
});

test('An Klaviyo senden: nur freigegebene Newsletter des eigenen Klienten, Vorlage mit sauberem HTML, kein Versand', async () => {
  kv = {};
  const senden = (token, body, id = a.id) => call('POST', `/api/klaviyo/senden/${id}`, { token, body });
  assert.equal((await senden(tok('viewer'), { reviewId: rvOk })).status, 403);
  assert.equal((await senden(H.clientToken(b.id), { reviewId: rvOk }, a.id)).status, 403);
  assert.equal((await senden(tok('editor'), { reviewId: rvFremd })).status, 404, 'Newsletter eines anderen Klienten');
  const offen = await senden(tok('editor'), { reviewId: rvOffen });
  assert.equal(offen.status, 409);
  assert.match(offen.body.error, /noch nicht freigegeben/);
  assert.equal((await senden(tok('editor'), { reviewId: 'abc' })).status, 400);
  const n0 = calls.length;
  const r = await senden(tok('editor'), { reviewId: rvOk });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vorlageId, 'TPL1');
  assert.equal(r.body.kampagneId, undefined);
  assert.match(r.body.hinweis, /Es wurde nichts versendet/);
  const post = calls.slice(n0).find(c => c.method === 'POST');
  assert.equal(post.url, 'https://a.klaviyo.com/api/templates/');
  assert.equal(post.headers.revision, '2024-02-15');
  assert.equal(post.headers.Authorization, `Klaviyo-API-Key ${KEY}`);
  assert.equal(post.body.data.type, 'template');
  assert.equal(post.body.data.attributes.editor_type, 'CODE');
  assert.match(post.body.data.attributes.name, /^Herbst <in> der Praxis \(RhetorIQ /);
  const h = post.body.data.attributes.html;
  assert.ok(!/<script/i.test(h));
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(h.includes('<strong>fett</strong>') && h.includes('<h2') && h.includes('<ul'));
  assert.ok(!/BETREFF:/.test(h));
  assert.ok(h.includes('Kurz &amp; knapp'), 'Vorschautext im versteckten Feld');
  const gesendet = (await pool.query('SELECT * FROM klaviyo_uebertragungen WHERE client_id=$1', [a.id])).rows;
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].vorlage_id, 'TPL1');
});

test('Kampagnenentwurf auf Wunsch: Entwurf mit Vorlage, bei Fehler bleibt die Vorlage; nie ein Versandaufruf', async () => {
  kv = {};
  const n0 = calls.length;
  const kamp = { listId: 'LIST1', absenderEmail: 'info@klaviyo-ag.ch', absenderName: 'Klaviyo AG' };
  const r = await call('POST', `/api/klaviyo/senden/${a.id}`, { token: tok('admin'), body: { reviewId: rvOk, kampagne: kamp } });
  assert.equal(r.status, 200);
  assert.equal(r.body.kampagneId, 'CAM1');
  const c = calls.slice(n0).filter(x => x.method === 'POST');
  assert.deepEqual(c.map(x => x.url.replace('https://a.klaviyo.com', '')), ['/api/templates/', '/api/campaigns/', '/api/campaign-message-assign-template/']);
  const cam = c[1].body.data.attributes;
  assert.deepEqual(cam.audiences.included, ['LIST1']);
  assert.equal(cam['campaign-messages'].data[0].attributes.content.from_email, 'info@klaviyo-ag.ch');
  assert.equal(c[2].body.data.relationships.template.data.id, 'TPL1');
  // Fehlerfall im Entwurf
  kv = { campaignPostStatus: 400 };
  const f = await call('POST', `/api/klaviyo/senden/${a.id}`, { token: tok('admin'), body: { reviewId: rvOk, kampagne: kamp } });
  assert.equal(f.status, 200);
  assert.equal(f.body.vorlageId, 'TPL1');
  assert.match(f.body.kampagneFehler, /Kampagnenentwurf konnte nicht angelegt werden.*Absender nicht verifiziert.*Vorlage ist angelegt/);
  const bad = await call('POST', `/api/klaviyo/senden/${a.id}`, { token: tok('admin'), body: { reviewId: rvOk, kampagne: { listId: 'x y', absenderEmail: 'kaputt' } } });
  assert.match(bad.body.kampagneFehler, /Liste und eine gültige Absenderadresse/);
  kv = {};
  // Über das ganze Testset: nur erlaubte Klaviyo-Pfade, nie ein Versand
  const erlaubt = [/^\/api\/templates\//, /^\/api\/lists\//, /^\/api\/campaigns\/(\?|$)/, /^\/api\/campaign-message-assign-template\/$/];
  for (const x of calls) {
    const p = x.url.replace('https://a.klaviyo.com', '');
    assert.ok(erlaubt.some(re => re.test(p)), 'unerwarteter Aufruf: ' + p);
    assert.ok(!/send/i.test(p), 'Versandaufruf: ' + p);
  }
});

test('Fehlerfälle beim Senden: ungültiger Schlüssel, fehlende Rechte, Limit, Serverfehler, Netz', async () => {
  const s = () => call('POST', `/api/klaviyo/senden/${a.id}`, { token: tok('editor'), body: { reviewId: rvOk } });
  kv = { templatePostStatus: 401 };
  let r = await s();
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ungültig oder wurde widerrufen/);
  kv = { templatePostStatus: 403 };
  r = await s();
  assert.match(r.body.error, /fehlen Rechte.*Templates/);
  kv = { templatePostStatus: 429 };
  r = await s();
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Limit erreicht/);
  kv = { templatePostStatus: 503 };
  r = await s();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /antwortet gerade nicht/);
  kv = { netz: true };
  r = await s();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /nicht erreichbar/);
  kv = { status: 422 };
  r = await s();
  assert.equal(r.status, 400);
  assert.ok(!r.body.error.includes(KEY), 'Fehlertexte von Klaviyo werden von Schlüsseln bereinigt');
  assert.match(r.body.error, /Schlüssel entfernt/);
  kv = {};
});

test('Nicht verbunden: verständliche Meldung; Trennen löscht den Schlüssel', async () => {
  const del = await call('DELETE', `/api/klaviyo/schluessel/${a.id}`, { token: tok('editor') });
  assert.equal(del.status, 403, 'nur admin');
  const ok = await call('DELETE', `/api/klaviyo/schluessel/${a.id}`, { token: tok('admin') });
  assert.equal(ok.body.verbunden, false);
  assert.equal((await gespeichert()).length, 0);
  const r = await call('POST', `/api/klaviyo/senden/${a.id}`, { token: tok('editor'), body: { reviewId: rvOk } });
  assert.equal(r.status, 409);
  assert.equal(r.body.nichtVerbunden, true);
  assert.equal((await call('GET', `/api/klaviyo/listen/${a.id}`, { token: tok('editor') })).status, 409);
});

test('Beraterin: gleiche Ablage serverseitig, alte Aufrufe mit Schlüssel im Körper funktionieren weiter', async () => {
  const adv = H.advisorToken();
  assert.equal((await call('GET', '/api/klaviyo/berater/status', { token: adv })).body.verbunden, false);
  assert.equal((await call('POST', '/api/klaviyo/templates', { token: adv, body: {} })).status, 400, 'ohne Schlüssel');
  const alt = await call('POST', '/api/klaviyo/templates', { token: adv, body: { apiKey: KEY } });
  assert.equal(alt.status, 200);
  assert.equal(alt.body.templates[0].id, 'T0');
  assert.equal((await call('PUT', '/api/klaviyo/berater/schluessel', { token: adv, body: { apiKey: KEY } })).status, 200);
  assert.equal((await call('GET', '/api/klaviyo/berater/status', { token: adv })).body.verbunden, true);
  const t = await call('POST', '/api/klaviyo/templates', { token: adv, body: {} });
  assert.equal(t.status, 200, 'gespeicherter Schlüssel genügt');
  const d = await call('POST', '/api/klaviyo/draft', { token: adv, body: { subject: 'Test', content: 'Hallo <b>Welt</b>' } });
  assert.equal(d.status, 200);
  assert.equal(d.body.templateId, 'TPL1');
  const post = calls.filter(c => c.method === 'POST' && c.url.endsWith('/api/templates/')).pop();
  assert.ok(post.body.data.attributes.html.includes('&lt;b&gt;Welt&lt;/b&gt;'));
  assert.equal((await call('POST', '/api/klaviyo/draft', { token: H.clientToken(a.id), body: { content: 'x', apiKey: KEY } })).status, 403, 'Klienten nutzen die alten Beraterinnen-Routen nicht');
  assert.ok(!JSON.stringify((await call('GET', '/api/klaviyo/berater/status', { token: adv })).body).includes(KEY));
  assert.equal((await call('DELETE', '/api/klaviyo/berater/schluessel', { token: adv })).body.verbunden, false);
});

test('Der Schlüssel taucht in keinem Log und keiner Fehlermeldung auf; Sentry und Fehlerbehandlung entfernen ihn', async () => {
  assert.ok(logs.length >= 0);
  assert.ok(!logs.some(l => l.includes(KEY)), 'Log enthält den Schlüssel');
  const { scrubText, sentryBeforeSend } = require('../lib/scrub');
  assert.ok(!scrubText(`Fehler bei ${KEY} und Klaviyo-API-Key ${KEY}`).includes(KEY));
  const ev = sentryBeforeSend({ message: `x ${KEY}`, request: { data: { apiKey: KEY }, cookies: 'a=b', headers: { authorization: `Klaviyo-API-Key ${KEY}` } }, exception: { values: [{ value: `boom ${KEY}` }] } });
  assert.ok(!JSON.stringify(ev).includes(KEY));
  assert.equal(ev.request.data, undefined);
  // kaputtes JSON mit Schlüssel im Körper: Meldung ohne Körperauszug
  const eh = require('../lib/errorHandler').errorHandler;
  const out = [];
  console.error = (...x) => { out.push(x.join(' ')); };
  eh({ type: 'entity.parse.failed', message: `Unexpected token in JSON "${KEY}"` }, { method: 'PUT', url: '/x' }, { headersSent: false, status() { return this; }, json() {} });
  assert.ok(!out.join('').includes(KEY));
});
