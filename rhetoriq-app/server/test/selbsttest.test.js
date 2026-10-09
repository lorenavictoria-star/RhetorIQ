// Selbsttest nach Störung: drei kurze Aufrufe, keine Einträge in analyses, keine Klienteninhalte im Ergebnis.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  a = await H.addClient('Alpha AG');
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice','GEHEIME STIMME ALPHA')`, [a.id]);
  b = await H.addClient('Beta AG');
  await pool.query(`UPDATE clients SET advisor_id = 2 WHERE id=$1`, [b.id]);
  srv = await H.startApp([['/api/status', require('../routes/status')]]);
});
test.after(async () => { await srv.close(); });

test('Drei Textarten, Dauer und Kosten, keine Texte, kein Eintrag in analyses', async () => {
  H.ai.fail = false; H.ai.calls.length = 0; H.ai.reply = 'GEHEIMER ERZEUGTER TEXT';
  const r = await srv.call('POST', '/api/status/selbsttest', { token: H.advisorToken(), body: { clientId: a.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.results.map(x => x.art), ['E-Mail', 'LinkedIn', 'Brief']);
  for (const x of r.body.results) { assert.equal(x.ok, true); assert.equal(typeof x.ms, 'number'); assert.equal(typeof x.kostenUsd, 'number'); }
  assert.equal(typeof r.body.kostenUsdTotal, 'number');
  const json = JSON.stringify(r.body);
  assert.ok(!json.includes('GEHEIMER ERZEUGTER TEXT'));
  assert.ok(!json.includes('GEHEIME STIMME'));
  assert.equal(H.ai.calls.length, 3, 'hart auf drei Aufrufe begrenzt');
  assert.ok(H.ai.calls.every(c => c.maxTokens <= 150 && c.meter.module === 'selbsttest'));
  assert.ok(H.ai.calls[0].system.includes('GEHEIME STIMME'), 'Stimme des Klienten fliesst in den Test ein');
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM analyses')).rows[0].n;
  assert.equal(n, 0);
});

test('Ohne Klient, Fehler werden pro Textart gemeldet', async () => {
  H.ai.calls.length = 0; H.ai.fail = true;
  const r = await srv.call('POST', '/api/status/selbsttest', { token: H.advisorToken(), body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.results.length, 3);
  assert.ok(r.body.results.every(x => x.ok === false && /kaputt/.test(x.fehler)));
  assert.equal(H.ai.calls.length, 3);
  H.ai.fail = false;
});

test('Nur Beraterin, nur eigene Klienten', async () => {
  assert.equal((await srv.call('POST', '/api/status/selbsttest', { token: H.clientToken(a.id), body: {} })).status, 403);
  assert.equal((await srv.call('POST', '/api/status/selbsttest', { body: {} })).status, 401);
  assert.equal((await srv.call('POST', '/api/status/selbsttest', { token: H.advisorToken(), body: { clientId: b.id } })).status, 403);
});
