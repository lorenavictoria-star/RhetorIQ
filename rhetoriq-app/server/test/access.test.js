// F-05: Zugang entziehen, alle Geräte abmelden, Sitzungsdauer, Rollenwechsel.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const H = require('../test-support/harness');
const { pool } = H;

let srv, c;
test.before(async () => {
  await H.setupBase();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT', 'created_at TIMESTAMPTZ DEFAULT NOW()']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  for (const col of ['monthly_token_limit BIGINT', 'recommended_plan TEXT', 'extra_users INTEGER DEFAULT 0']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  await pool.query('CREATE UNIQUE INDEX client_users_ce ON client_users (client_id, email)').catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT, role TEXT, department TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  await pool.query(`INSERT INTO users (email, name, password_hash) VALUES ('zwei@test.ch','Zwei', 'x')`);
  c = await H.addClient('Zugang AG');
  await pool.query('UPDATE clients SET password_hash=$1 WHERE id=$2', [await bcrypt.hash('geheimespasswort', 4), c.id]);
  const probe = require('express').Router();
  probe.get('/', require('../middleware/auth').requireAuth, (req, res) => res.json({ ok: true }));
  srv = await H.startApp([['/auth', require('../routes/auth')], ['/api/clients', require('../routes/clients')], ['/probe', probe]]);
});
test.after(async () => { await srv.close(); });

test('F-05 Normalfall: Token-Login und Passwort-Login funktionieren, Sitzung höchstens 30 Tage', async () => {
  const r = await srv.call('POST', '/auth/client-login', { body: { token: c.token } });
  assert.equal(r.status, 200);
  const d = jwt.decode(r.body.token);
  assert.ok(d.exp - d.iat <= 30 * 86400);
  const r2 = await srv.call('POST', '/auth/client-password-login', { body: { email: 'k@test.ch', password: 'geheimespasswort' } });
  assert.equal(r2.status, 200);
  const d2 = jwt.decode(r2.body.token);
  assert.ok(d2.exp - d2.iat <= 30 * 86400);
});

test('F-05 Alle Geräte abmelden: Sitzung ungültig, Zugangscode bleibt', async () => {
  const sess = (await srv.call('POST', '/auth/client-login', { body: { token: c.token } })).body.token;
  assert.equal((await srv.call('GET', '/probe', { token: sess })).status, 200);
  assert.equal((await srv.call('POST', `/api/clients/${c.id}/logout-all-devices`, { token: H.clientToken(c.id) })).status, 403, 'Klient selbst darf das hier nicht');
  assert.equal((await srv.call('POST', `/api/clients/${c.id}/logout-all-devices`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('GET', '/probe', { token: sess })).status, 401);
  assert.equal((await srv.call('POST', '/auth/client-login', { body: { token: c.token } })).status, 200, 'Code gilt weiter');
});

test('F-05 Zugang entziehen: alter Code und alte Sitzungen tot, neuer Code gilt', async () => {
  const sess = (await srv.call('POST', '/auth/client-login', { body: { token: c.token } })).body.token;
  await pool.query(`INSERT INTO client_users (client_id, email, name, role, password_hash) VALUES ($1,'m@test.ch','M','editor',$2)`, [c.id, await bcrypt.hash('teampasswort1', 4)]);
  const team = (await srv.call('POST', '/auth/client-user-login', { body: { email: 'm@test.ch', password: 'teampasswort1' } })).body.token;
  assert.equal((await srv.call('GET', '/probe', { token: team })).status, 200);
  assert.equal((await srv.call('POST', `/api/clients/${c.id}/revoke-access`, { token: H.advisorToken({ id: 2 }) })).status, 404, 'fremde Beraterin');
  const rv = await srv.call('POST', `/api/clients/${c.id}/revoke-access`, { token: H.advisorToken(), body: {} });
  assert.equal(rv.status, 200);
  assert.ok(rv.body.token && rv.body.token !== c.token);
  assert.equal((await srv.call('GET', '/probe', { token: sess })).status, 401);
  assert.equal((await srv.call('GET', '/probe', { token: team })).status, 401);
  assert.equal((await srv.call('POST', '/auth/client-login', { body: { token: c.token } })).status, 401, 'alter Code tot');
  assert.equal((await srv.call('POST', '/auth/client-login', { body: { token: rv.body.token } })).status, 200, 'neuer Code gilt');
  assert.equal((await srv.call('POST', '/auth/client-password-login', { body: { email: 'k@test.ch', password: 'geheimespasswort' } })).status, 200, 'Passwort bleibt ohne resetPassword');
  const rv2 = await srv.call('POST', `/api/clients/${c.id}/revoke-access`, { token: H.advisorToken(), body: { resetPassword: true } });
  assert.equal(rv2.status, 200);
  assert.equal((await srv.call('POST', '/auth/client-password-login', { body: { email: 'k@test.ch', password: 'geheimespasswort' } })).status, 401);
});

test('F-05 Rollenwechsel eines Teammitglieds beendet dessen alte Sitzung; ungültige Rolle abgelehnt', async () => {
  const add = (role) => srv.call('POST', `/api/clients/${c.id}/users`, { token: H.advisorToken(), body: { email: 'r@test.ch', name: 'R', password: 'teampasswort1', role } });
  assert.equal((await add('superuser')).status, 400);
  assert.equal((await add('editor')).status, 201);
  const old = (await srv.call('POST', '/auth/client-user-login', { body: { email: 'r@test.ch', password: 'teampasswort1' } })).body.token;
  assert.equal((await srv.call('GET', '/probe', { token: old })).status, 200);
  assert.equal((await add('viewer')).status, 201);
  assert.equal((await srv.call('GET', '/probe', { token: old })).status, 401);
  const nw = (await srv.call('POST', '/auth/client-user-login', { body: { email: 'r@test.ch', password: 'teampasswort1' } })).body.token;
  assert.equal(jwt.decode(nw).clientUserRole, 'viewer');
});
