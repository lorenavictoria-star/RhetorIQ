// F-06: Teamrollen im Server durchsetzen, Hauptpasswort nur durch den Hauptzugang mit bisherigem Passwort.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const H = require('../test-support/harness');
const { pool } = H;

let srv, c, cuId = {};
test.before(async () => {
  await H.setupBase();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`CREATE TABLE people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT, role TEXT, department TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (client_id, memory_type))`);
  await pool.query(`CREATE TABLE company_memory_history (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  c = await H.addClient('Rollen AG');
  await pool.query('UPDATE clients SET password_hash=$1 WHERE id=$2', [await bcrypt.hash('hauptpasswort1', 4), c.id]);
  for (const role of ['viewer', 'editor', 'admin']) {
    cuId[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [c.id, role + '@t.ch', role, role])).rows[0].id;
  }
  srv = await H.startApp([['/auth', require('../routes/auth')], ['/api/memory', require('../routes/memory')], ['/api/people', require('../routes/people')], ['/api/subscriptions', require('../routes/subscriptions')]]);
});
test.after(async () => { await srv.close(); });

const team = (role) => H.clientToken(c.id, { clientUserId: cuId[role], clientUserRole: role });

test('F-06 Betrachter darf nichts ändern, Bearbeiter schon', async () => {
  assert.equal((await srv.call('PUT', `/api/memory/${c.id}/brand`, { token: team('viewer'), body: { content: 'x' } })).status, 403);
  assert.equal((await srv.call('POST', '/api/people', { token: team('viewer'), body: { name: 'A' } })).status, 403);
  assert.equal((await srv.call('PUT', `/api/memory/${c.id}/brand`, { token: team('editor'), body: { content: 'x' } })).status, 200);
  assert.equal((await srv.call('POST', '/api/people', { token: team('editor'), body: { name: 'A' } })).status, 200);
  assert.equal((await srv.call('GET', `/api/memory/${c.id}`, { token: team('viewer') })).status, 200, 'Lesen bleibt erlaubt');
});

test('F-06 Gedächtnis löschen und Abo: nur Admin, Hauptzugang oder Beraterin', async () => {
  assert.equal((await srv.call('DELETE', `/api/memory/${c.id}`, { token: team('editor') })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/memory/${c.id}`, { token: team('viewer') })).status, 403);
  assert.equal((await srv.call('POST', `/api/subscriptions/portal-link/${c.id}`, { token: team('editor'), body: {} })).status, 403);
  assert.equal((await srv.call('POST', `/api/subscriptions/skip-plan/${c.id}`, { token: team('viewer'), body: {} })).status, 403);
  assert.equal((await srv.call('POST', `/api/subscriptions/skip-plan/${c.id}`, { token: team('admin'), body: {} })).status, 200);
  assert.equal((await srv.call('POST', `/api/subscriptions/skip-plan/${c.id}`, { token: H.clientToken(c.id), body: {} })).status, 200, 'Hauptzugang');
  assert.equal((await srv.call('DELETE', `/api/memory/${c.id}`, { token: team('admin') })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/memory/${c.id}`, { token: H.clientToken(c.id) })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/memory/${c.id}`, { token: H.advisorToken() })).status, 200);
});

test('F-06 Hauptpasswort: nicht durch Teammitglieder, nur mit bisherigem Passwort', async () => {
  const body = { newPassword: 'neuespasswort12', currentPassword: 'hauptpasswort1' };
  assert.equal((await srv.call('POST', '/auth/client-change-password', { token: team('admin'), body })).status, 403);
  assert.equal((await srv.call('POST', '/auth/client-change-password', { token: team('viewer'), body })).status, 403);
  assert.equal((await srv.call('POST', '/auth/client-change-password', { token: H.clientToken(c.id), body: { newPassword: 'neuespasswort12' } })).status, 401, 'ohne bisheriges Passwort');
  assert.equal((await srv.call('POST', '/auth/client-change-password', { token: H.clientToken(c.id), body: { newPassword: 'neuespasswort12', currentPassword: 'falsch' } })).status, 401);
  const ok = await srv.call('POST', '/auth/client-change-password', { token: H.clientToken(c.id), body });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test('F-06 Erster Passwortwechsel (must_change_password) funktioniert weiterhin ohne bisheriges Passwort', async () => {
  const c2 = await H.addClient('Neu AG');
  await pool.query('UPDATE clients SET password_hash=$1, must_change_password=TRUE WHERE id=$2', [await bcrypt.hash('startpasswort', 4), c2.id]);
  const r = await srv.call('POST', '/auth/client-change-password', { token: H.clientToken(c2.id), body: { newPassword: 'eigenespasswort1' } });
  assert.equal(r.status, 200);
  const again = await srv.call('POST', '/auth/client-change-password', { token: H.clientToken(c2.id, { tokenVersion: 2 }), body: { newPassword: 'nochmal12345' } });
  assert.equal(again.status, 401, 'danach nur noch mit bisherigem Passwort');
});
