// Eine Anmeldung für alle: Beraterin, Klient (Hauptzugang) und Teammitglied über /auth/login-any.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const H = require('../test-support/harness');
const { pool } = H;

let srv, client;
test.before(async () => {
  await H.setupBase();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=1`, [await bcrypt.hash('beraterin-langes-passwort', 4)]);
  client = await H.addClient('Anmeldefirma AG');
  await pool.query(`UPDATE clients SET email='kunde@test.ch', password_hash=$1 WHERE id=$2`, [await bcrypt.hash('kunde-langes-passwort', 4), client.id]);
  await pool.query(`INSERT INTO client_users (client_id, email, name, password_hash, role) VALUES ($1,'team@test.ch','Team Mitglied',$2,'member')`,
    [client.id, await bcrypt.hash('team-langes-passwort', 4)]);
  srv = await H.startApp([['/auth', require('../routes/auth')]]);
});
test.after(async () => { await srv.close(); });
test.beforeEach(() => require('../lib/loginLock').reset());

const login = (email, password) => srv.call('POST', '/auth/login-any', { body: { email, password } });

test('Beraterin meldet sich im gemeinsamen Formular an', async () => {
  const r = await login('Lorena@Test.ch ', 'beraterin-langes-passwort');
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'advisor');
  assert.equal(jwt.verify(r.body.token, process.env.JWT_SECRET).role, 'advisor');
});

test('Klient meldet sich im gleichen Formular an und bekommt eine Klienten-Sitzung', async () => {
  const r = await login('kunde@test.ch', 'kunde-langes-passwort');
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'client');
  assert.equal(r.body.client.id, client.id);
  const t = jwt.verify(r.body.token, process.env.JWT_SECRET);
  assert.equal(t.role, 'client');
  assert.equal(t.clientId, client.id);
});

test('Teammitglied meldet sich an und trägt die eigene Kennung in der Sitzung', async () => {
  const r = await login('team@test.ch', 'team-langes-passwort');
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'client');
  assert.equal(r.body.clientUser.email, 'team@test.ch');
  assert.ok(jwt.verify(r.body.token, process.env.JWT_SECRET).clientUserId);
});

test('Falsches Passwort und unbekannte Adresse geben dieselbe Antwort', async () => {
  const a = await login('kunde@test.ch', 'falsch');
  const b = await login('gibts-nicht@test.ch', 'falsch');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('Klient im Papierkorb kann sich nicht anmelden', async () => {
  await pool.query(`UPDATE clients SET geloescht_am = NOW() WHERE id=$1`, [client.id]);
  assert.equal((await login('kunde@test.ch', 'kunde-langes-passwort')).status, 401);
  await pool.query(`UPDATE clients SET geloescht_am = NULL WHERE id=$1`, [client.id]);
  assert.equal((await login('kunde@test.ch', 'kunde-langes-passwort')).status, 200);
});

test('Gleiche Adresse bei Klient und Klient im Papierkorb: das Passwort entscheidet, der gelöschte zählt nicht', async () => {
  const alt = await H.addClient('Alte Firma AG');
  await pool.query(`UPDATE clients SET email='kunde@test.ch', password_hash=$1, geloescht_am=NOW() WHERE id=$2`, [await bcrypt.hash('altes-langes-passwort', 4), alt.id]);
  assert.equal((await login('kunde@test.ch', 'altes-langes-passwort')).status, 401);
  assert.equal((await login('kunde@test.ch', 'kunde-langes-passwort')).status, 200);
});

test('Sperre nach 10 Fehlversuchen gilt für die Adresse, unabhängig von der Kontoart', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('kunde@test.ch', 'falsch' + i)).status, 401);
  assert.equal((await login('kunde@test.ch', 'kunde-langes-passwort')).status, 429);
  assert.equal((await login('lorena@test.ch', 'beraterin-langes-passwort')).status, 200);
});
