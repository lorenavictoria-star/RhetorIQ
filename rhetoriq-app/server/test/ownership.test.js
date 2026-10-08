// Klienten dürfen nur eigene Daten sehen und verändern (Befund F-01).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
  await pool.query(`CREATE TABLE IF NOT EXISTS people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT, role TEXT, department TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS people_profiles (id SERIAL PRIMARY KEY, person_id INTEGER, profile_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  srv = await H.startApp([
    ['/api/people', require('../routes/people')],
    ['/api/custom-modules', require('../routes/customModules')],
    ['/api/analyze', require('../routes/analyze')],
    ['/api/fetch-website', require('../routes/fetchWebsite')]
  ]);
});
test.after(async () => { await srv.close(); });

test('F-01 Personen: Klient sieht und ändert nur eigene', async () => {
  const mine = await srv.call('POST', '/api/people', { token: H.clientToken(a.id), body: { name: 'Anna', clientId: b.id } });
  assert.equal(mine.status, 200);
  const { rows: pr } = await pool.query('SELECT client_id FROM people WHERE id=$1', [mine.body.id]);
  assert.equal(pr[0].client_id, a.id, 'trotz fremder Nummer im eigenen Bereich angelegt');
  const bp = await srv.call('POST', '/api/people', { token: H.clientToken(b.id), body: { name: 'Bruno' } });
  const pid = bp.body.id;
  assert.equal((await srv.call('PUT', `/api/people/${pid}`, { token: H.clientToken(a.id), body: { name: 'X' } })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/people/${pid}`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/people/${pid}`, { token: H.clientToken(b.id) })).status, 200);
});

test('F-01 Eigene Module: fremde Liste und fremder Lauf gesperrt', async () => {
  const own = await srv.call('GET', `/api/custom-modules?clientId=${b.id}`, { token: H.clientToken(a.id) });
  assert.equal(own.status, 200);
  assert.equal(own.body.length, 0);
  const mk = await srv.call('POST', '/api/custom-modules', { token: H.advisorToken(), body: { client_id: b.id, name: 'M', system_prompt: 'p' } });
  assert.equal(mk.status, 200);
  const run = await srv.call('POST', `/api/custom-modules/${mk.body.id}/run`, { token: H.clientToken(a.id), body: { inputs: {} } });
  assert.equal(run.status, 403);
});

test('F-01 Auswertung und Löschen: Klient nur eigener Bereich', async () => {
  assert.equal((await srv.call('DELETE', `/api/analyze/client/${b.id}`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/analyze/health-score?clientId=${b.id}`, { token: H.clientToken(a.id) })).status !== 403, true, 'Klient wird auf eigene Nummer umgelenkt');
  const { rows } = await pool.query(`INSERT INTO analyses (client_id, advisor_id, module) VALUES ($1,1,'x') RETURNING id`, [b.id]);
  assert.equal((await srv.call('DELETE', `/api/analyze/${rows[0].id}`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/analyze/${rows[0].id}`, { token: H.clientToken(b.id, { clientUserRole: 'admin' }) })).status, 200);
});
