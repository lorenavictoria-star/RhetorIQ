// Brevo, Mailchimp, WordPress: verbinden, Liste wählen, Entwurf ablegen. Aufrufe sind gemockt, es wird nie versendet oder veröffentlicht.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('../test-support/harness');
const { pool } = H;

process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const BREVO = 'xkeysib-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';          // Testwerte, keine echten Schlüssel
const MAILCHIMP = ['a1b2c3d4e5f6a7b8', 'c9d0e1f2a3b4c5d6'].join('') + '-' + 'us21';   // zur Laufzeit zusammengesetzt, damit kein Scanner den Testwert für einen echten Schlüssel hält
const WP_PW = 'abcd efgh ijkl mnop qrst uvwx';
const calls = [];
let verhalten = {};
const logs = [];
const origLog = { log: console.log, error: console.error, warn: console.warn };
for (const k of ['log', 'error', 'warn']) console[k] = (...a) => { logs.push(a.map(x => (x && x.stack) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };

let srv, a, b, tm = {};
const tok = (role, cid) => H.clientToken((cid || a.id), { clientUserId: tm[role], clientUserRole: role });
const call = (m, u, o) => srv.call(m, u, o);

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE review_requests ADD COLUMN module_tile TEXT').catch(() => {});
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  a = await H.addClient('KMU AG'); b = await H.addClient('Fremd AG');
  await require('../lib/schemaRedesign').ensureSchema();
  for (const role of ['admin', 'editor']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@k.ch', role, role])).rows[0].id;
  const I = require('../lib/integrationen');
  I._setzeTransport(async (req) => {
    calls.push({ ...req, body: req.body ? JSON.parse(req.body) : null });
    if (verhalten.status) return { status: verhalten.status, json: { message: 'Abgelehnt mit ' + BREVO } };
    const u = req.url;
    if (u === 'https://api.brevo.com/v3/account') return { status: 200, json: {} };
    if (u.startsWith('https://api.brevo.com/v3/contacts/lists')) return { status: 200, json: { lists: [{ id: 12, name: 'Kundenliste' }] } };
    if (u === 'https://api.brevo.com/v3/emailCampaigns') return { status: 201, json: { id: 77 } };
    if (u === 'https://us21.api.mailchimp.com/3.0/ping') return { status: 200, json: {} };
    if (u.startsWith('https://us21.api.mailchimp.com/3.0/lists')) return { status: 200, json: { lists: [{ id: 'abc123', name: 'Hauptliste' }] } };
    if (u === 'https://us21.api.mailchimp.com/3.0/campaigns') return { status: 200, json: { id: 'CAMP1' } };
    if (u === 'https://us21.api.mailchimp.com/3.0/campaigns/CAMP1/content') return { status: 200, json: {} };
    if (u.startsWith('https://blog.kmu.ch/wp-json/wp/v2/users/me')) return { status: 200, json: { id: 1 } };
    if (u === 'https://blog.kmu.ch/wp-json/wp/v2/posts') return { status: 201, json: { id: 321 } };
    return { status: 404, json: { message: 'unbekannt' } };
  });
  srv = await H.startApp([['/api/integrationen', require('../routes/integrationen')]]);
});
test.after(async () => { await srv.close(); require('../lib/integrationen')._setzeTransport(null); Object.assign(console, origLog); });

const TEXT = 'BETREFF: Herbst in der Praxis\nVORSCHAU: Kurz und knapp\n\nLiebe Leserin\n\nText mit **fett**.\n\nHerzliche Grüsse';

test('Verbinden: nur Rolle admin, Format wird geprüft, Zugangsdaten liegen verschlüsselt und erscheinen nie in Antworten', async () => {
  assert.equal((await call('PUT', `/api/integrationen/brevo/${a.id}`, { token: tok('editor'), body: { apiKey: BREVO } })).status, 403);
  assert.equal((await call('PUT', `/api/integrationen/brevo/${a.id}`, { token: tok('admin'), body: { apiKey: 'zu kurz' } })).status, 400);
  assert.equal((await call('PUT', `/api/integrationen/unbekannt/${a.id}`, { token: tok('admin'), body: { apiKey: BREVO } })).status, 404);
  const r = await call('PUT', `/api/integrationen/brevo/${a.id}`, { token: tok('admin'), body: { apiKey: BREVO } });
  assert.equal(r.status, 200); assert.equal(JSON.stringify(r.body).includes(BREVO), false);
  const rows = (await pool.query('SELECT * FROM integration_zugang')).rows;
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(BREVO), false, 'verschlüsselt abgelegt');
  const st = await call('GET', `/api/integrationen/status/${a.id}`, { token: tok('editor') });
  assert.equal(st.body.anbieter.brevo.verbunden, true); assert.equal(st.body.anbieter.mailchimp.verbunden, false);
  assert.equal(JSON.stringify(st.body).includes(BREVO), false);
  // fremder Klient sieht nichts
  assert.ok([403, 404].includes((await call('GET', `/api/integrationen/status/${b.id}`, { token: tok('admin') })).status));
});

test('Brevo: erst Liste und Absender, dann Entwurf; gemerkt für das nächste Mal; nie ein Versand', async () => {
  const l = await call('GET', `/api/integrationen/brevo/listen/${a.id}`, { token: tok('editor') });
  assert.deepEqual(l.body.listen, [{ id: '12', name: 'Kundenliste' }]);
  let r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT } });
  assert.equal(r.status, 409); assert.equal(r.body.voreinstellungFehlt, true);
  assert.equal((await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT, kampagne: { listId: '12', absenderEmail: 'kaputt' } } })).status, 400);
  r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT, kampagne: { listId: '12', absenderEmail: 'info@kmu.ch', absenderName: 'KMU' }, merken: true } });
  assert.equal(r.status, 200); assert.equal(r.body.id, '77');
  const post = calls.filter(c => c.url === 'https://api.brevo.com/v3/emailCampaigns').pop();
  assert.equal(post.body.subject, 'Herbst in der Praxis');
  assert.deepEqual(post.body.recipients.listIds, [12]);
  assert.equal(post.body.sender.email, 'info@kmu.ch');
  assert.equal(post.headers['api-key'], BREVO, 'Schlüssel nur im Header zu Brevo');
  r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT } });
  assert.equal(r.status, 200, 'gemerkte Voreinstellung genügt');
  for (const c of calls) assert.ok(!/send/i.test(c.url), 'Versandaufruf: ' + c.url);
});

test('Mailchimp: Kampagne und Inhalt als Entwurf, kein Versand-Endpunkt', async () => {
  assert.equal((await call('PUT', `/api/integrationen/mailchimp/${a.id}`, { token: tok('admin'), body: { apiKey: 'falsch' } })).status, 400);
  assert.equal((await call('PUT', `/api/integrationen/mailchimp/${a.id}`, { token: tok('admin'), body: { apiKey: MAILCHIMP } })).status, 200);
  const l = await call('GET', `/api/integrationen/mailchimp/listen/${a.id}`, { token: tok('editor') });
  assert.equal(l.body.listen[0].id, 'abc123');
  const n0 = calls.length;
  const r = await call('POST', `/api/integrationen/mailchimp/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT, kampagne: { listId: 'abc123', absenderEmail: 'info@kmu.ch', absenderName: 'KMU' } } });
  assert.equal(r.status, 200); assert.equal(r.body.id, 'CAMP1');
  const c = calls.slice(n0);
  assert.deepEqual(c.map(x => x.method + ' ' + x.url.replace('https://us21.api.mailchimp.com/3.0', '')), ['POST /campaigns', 'PUT /campaigns/CAMP1/content']);
  assert.equal(c[0].body.settings.subject_line, 'Herbst in der Praxis');
  assert.equal(c[0].body.recipients.list_id, 'abc123');
  assert.match(c[1].body.html, /Herbst|Liebe Leserin/);
  for (const x of calls) assert.ok(!/actions\/send|send/i.test(x.url), 'Versandaufruf: ' + x.url);
});

test('WordPress: nur https und keine internen Adressen; Beitrag als Entwurf, nie veröffentlicht', async () => {
  const put = (site) => call('PUT', `/api/integrationen/wordpress/${a.id}`, { token: tok('admin'), body: { site, user: 'lorena', apiKey: WP_PW } });
  assert.equal((await put('http://blog.kmu.ch')).status, 400, 'nur https');
  assert.equal((await put('https://127.0.0.1')).status, 400, 'Loopback gesperrt');
  assert.equal((await put('https://10.0.0.5')).status, 400, 'private Adresse gesperrt');
  assert.equal((await put('https://localhost')).status, 400);
  assert.equal((await put('https://blog.kmu.ch')).status, 200);
  const n0 = calls.length;
  const r = await call('POST', `/api/integrationen/wordpress/direkt/${a.id}`, { token: tok('editor'), body: { text: 'Neue Praxis in Bern\n\nEs gibt Neuigkeiten.\n\n- Punkt eins\n- Punkt zwei' } });
  assert.equal(r.status, 200); assert.equal(r.body.id, '321');
  const post = calls.slice(n0).find(x => x.method === 'POST');
  assert.equal(post.body.status, 'draft', 'nie veröffentlichen');
  assert.equal(post.body.title, 'Neue Praxis in Bern');
  assert.match(post.body.content, /<p>Es gibt Neuigkeiten\.<\/p>/);
  assert.match(post.body.content, /<ul><li>Punkt eins<\/li>/);
  assert.equal(post.sicher, true, 'läuft über den geschützten Abruf');
  assert.match(post.headers.authorization, /^Basic /);
});

test('Fehler: Zugang ungültig und Limit verständlich, Schlüssel taucht in Antwort und Logs nie auf; Trennen löscht alles', async () => {
  verhalten = { status: 401 };
  let r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Zugang zu Brevo ist ungültig/);
  verhalten = { status: 400 };
  r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT } });
  assert.equal(JSON.stringify(r.body).includes(BREVO), false);
  verhalten = {};
  assert.equal(logs.join('\n').includes(BREVO), false);
  assert.equal(logs.join('\n').includes(MAILCHIMP), false);
  assert.equal((await call('DELETE', `/api/integrationen/brevo/${a.id}`, { token: tok('admin') })).status, 200);
  r = await call('POST', `/api/integrationen/brevo/direkt/${a.id}`, { token: tok('editor'), body: { text: TEXT } });
  assert.equal(r.status, 409); assert.equal(r.body.nichtVerbunden, true);
  assert.equal((await pool.query(`SELECT * FROM integration_voreinstellung WHERE anbieter='brevo'`)).rows.length, 0);
});

test('Automatische Ablage nach der Freigabe: nur Newsletter, nur mit gemerkter Voreinstellung, nur einmal', async () => {
  const I = require('../lib/integrationen');
  const { nachFreigabe } = require('../lib/integrationAuto');
  await I.speichere(a.id, 'brevo', { apiKey: BREVO });
  assert.deepEqual(await nachFreigabe({ id: 5001, client_id: a.id, module_tile: 'newsletter' }, TEXT), [], 'ohne Voreinstellung nichts');
  await I.merkeVoreinstellung(a.id, 'brevo', { listId: '12', absenderEmail: 'info@kmu.ch', absenderName: 'KMU' });
  assert.deepEqual(await nachFreigabe({ id: 5001, client_id: a.id, module_tile: 'email' }, TEXT), [], 'kein Newsletter');
  const r = await nachFreigabe({ id: 5001, client_id: a.id, module_tile: 'newsletter' }, TEXT);
  assert.equal(r.length, 1); assert.equal(r[0].id, '77');
  assert.deepEqual(await nachFreigabe({ id: 5001, client_id: a.id, module_tile: 'newsletter' }, TEXT), [], 'nicht doppelt');
});
