// Nur Beratung: Klient ohne Zugang, von der Beraterin betreut. Keine Mails, kein Login, Freischaltung per Klick.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

let srv;
const A = () => H.advisorToken();
test.before(async () => {
  await H.setupBase();
  await require('../lib/schemaRedesign').ensureSchema();
  for (const col of ['capital_markets_enabled BOOLEAN DEFAULT FALSE', 'hotel_enabled BOOLEAN DEFAULT FALSE']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  srv = await H.startApp([
    ['/api/clients', require('../routes/clients')],
    ['/api/advisor', require('../routes/advisor')],
    ['/api/auth', require('../routes/auth')]
  ]);
});
test.after(async () => { await srv.close(); });

test('Anlegen als «Nur Beratung»: Merkmal gesetzt, keine Mail, erscheint im Dashboard', async () => {
  const vorher = H.brevoMails.length;
  const r = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Beratung AG', email: 'kontakt@beratung.example', privacyAcknowledged: true, nurBeratung: true } });
  assert.equal(r.status, 201);
  assert.equal(r.body.nur_beratung, true);
  await new Promise(res => setTimeout(res, 50));
  assert.equal(H.brevoMails.length, vorher, 'weder Willkommens- noch Zugangsmail');
  const liste = await srv.call('GET', '/api/clients', { token: A() });
  assert.equal(liste.body.find(c => c.id === r.body.id).nur_beratung, true);
  const dash = await srv.call('GET', '/api/advisor/dashboard', { token: A() });
  assert.equal(dash.body.clients.find(c => c.id === r.body.id).nur_beratung, true);
});

test('Normaler Klient bleibt unverändert', async () => {
  const r = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Normal GmbH', privacyAcknowledged: true } });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.nur_beratung, true);
});

test('Login mit dem Zugangscode ist gesperrt, solange nur Beratung', async () => {
  const r = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Gesperrt AG', privacyAcknowledged: true, nurBeratung: true } });
  const token = (await pool.query('SELECT token FROM clients WHERE id=$1', [r.body.id])).rows[0].token;
  const login = await srv.call('POST', '/api/auth/client-login', { body: { token } });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /nicht freigeschaltet/);
});

test('Freischalten: Merkmal weg, Login geht, Willkommensmail nur auf Wunsch', async () => {
  const r = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Frei AG', email: 'frei@example.ch', privacyAcknowledged: true, nurBeratung: true } });
  const id = r.body.id;
  const token = (await pool.query('SELECT token FROM clients WHERE id=$1', [id])).rows[0].token;
  const vorher = H.brevoMails.length;
  const f = await srv.call('POST', `/api/clients/${id}/zugang-freischalten`, { token: A(), body: {} });
  assert.equal(f.status, 200);
  assert.equal(f.body.nur_beratung, false);
  assert.equal(f.body.willkommenGesendet, false);
  await new Promise(res => setTimeout(res, 50));
  assert.equal(H.brevoMails.length, vorher, 'ohne sendWelcome keine Mail');
  const login = await srv.call('POST', '/api/auth/client-login', { body: { token } });
  assert.equal(login.status, 200);
  const r2 = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Frei Zwei AG', email: 'zwei@example.ch', privacyAcknowledged: true, nurBeratung: true } });
  const f2 = await srv.call('POST', `/api/clients/${r2.body.id}/zugang-freischalten`, { token: A(), body: { sendWelcome: true } });
  assert.equal(f2.body.willkommenGesendet, true);
});

test('Freischalten: ohne Token 401, fremder Klient 404', async () => {
  assert.equal((await srv.call('POST', '/api/clients/1/zugang-freischalten', { body: {} })).status, 401);
  assert.equal((await srv.call('POST', '/api/clients/999999/zugang-freischalten', { token: A(), body: {} })).status, 404);
});
