const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, c;
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT', 'created_at TIMESTAMPTZ DEFAULT NOW()']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query('CREATE UNIQUE INDEX client_users_ce ON client_users (client_id, email)').catch(() => {});
  await pool.query(`CREATE TABLE people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT)`).catch(() => {});
  c = await H.addClient('Limit AG');
  srv = await H.startApp([['/api/clients', require('../routes/clients')]]);
});
test.after(async () => { await srv.close(); });

const add = (email) => srv.call('POST', `/api/clients/${c.id}/users`, { token: H.advisorToken(), body: { email, name: 'N ' + email, password: 'geheim1234', role: 'editor' } });

test('Ohne Paket unbegrenzt, Stimme erlaubt nur den Hauptzugang, Zusatznutzer öffnen Plätze', async () => {
  assert.equal((await add('a@x.ch')).status, 201, 'kein Paket: unbegrenzt');
  await pool.query('DELETE FROM client_users WHERE client_id=$1', [c.id]);
  await pool.query('UPDATE clients SET monthly_token_limit=200000 WHERE id=$1', [c.id]);
  const st = await srv.call('GET', `/api/clients/${c.id}/user-limit`, { token: H.advisorToken() });
  assert.equal(st.body.plan, 'stimme');
  assert.equal(st.body.limit, 1);
  assert.equal(st.body.used, 1);
  const no = await add('b@x.ch');
  assert.equal(no.status, 409);
  assert.ok(/Zusatznutzer/.test(no.body.error));
  const up = await srv.call('PUT', `/api/clients/${c.id}/extra-users`, { token: H.advisorToken(), body: { extra_users: 2 } });
  assert.equal(up.body.limit, 3);
  assert.equal((await add('b@x.ch')).status, 201);
  assert.equal((await add('c@x.ch')).status, 201);
  assert.equal((await add('d@x.ch')).status, 409);
  assert.equal((await add('b@x.ch')).status, 201, 'bestehende Person darf aktualisiert werden');
});

test('Team erlaubt 5 Personen, Business 15, Enterprise unbegrenzt', async () => {
  const ul = require('../lib/userLimit');
  assert.equal(ul.baseFor({ monthly_token_limit: 750000 }).base, 5);
  assert.equal(ul.baseFor({ monthly_token_limit: 2000000 }).base, 15);
  assert.equal(ul.baseFor({ recommended_plan: 'enterprise' }).base, null);
  assert.equal(ul.baseFor({}).base, null);
});
