const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const q = require('../lib/quartalsreview');

let srv, biz, team, plain;
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  biz = await H.addClient('Business AG'); team = await H.addClient('Team AG'); plain = await H.addClient('Ohne Paket AG');
  await pool.query('UPDATE clients SET monthly_token_limit=2000000 WHERE id=$1', [biz.id]);
  await pool.query('UPDATE clients SET monthly_token_limit=750000 WHERE id=$1', [team.id]);
  srv = await H.startApp([['/api/quartalsreview', require('../routes/quartalsreview')]]);
});
test.after(async () => { await srv.close(); });

test('Quartal aus Datum', () => {
  assert.equal(q.quartalOf(new Date('2026-01-15T00:00:00Z')), '2026-Q1');
  assert.equal(q.quartalOf(new Date('2026-10-09T00:00:00Z')), '2026-Q4');
  assert.equal(q.quartalOf(new Date('2026-06-30T12:00:00Z')), '2026-Q2');
  assert.ok(q.validQuartal('2026-Q3') && !q.validQuartal('2026-Q5') && !q.validQuartal('26-Q1'));
});

test('Fälligkeit: nur Business, offen bis erledigt', async () => {
  const cur = q.quartalOf();
  let r = await srv.call('GET', '/api/quartalsreview/due', { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clients.map(c => c.name), ['Business AG']);
  assert.equal(r.body.clients[0].open, true);
  let w = await q.weeklyLines();
  assert.ok(w.some(l => l.startsWith('Quartalsreview offen: Business AG')));
  assert.ok(!w.some(l => /Team AG/.test(l)));

  const put = await srv.call('PUT', `/api/quartalsreview/${biz.id}/${cur}`, { token: H.advisorToken(), body: { termin: '12.11.2026, 10 Uhr', notizen: 'Kurz besprechen', status: 'geplant' } });
  assert.equal(put.status, 200);
  r = await srv.call('GET', '/api/quartalsreview/due', { token: H.advisorToken() });
  assert.equal(r.body.clients[0].status, 'geplant');
  assert.equal(r.body.clients[0].open, true);

  await srv.call('PUT', `/api/quartalsreview/${biz.id}/${cur}`, { token: H.advisorToken(), body: { status: 'erledigt' } });
  r = await srv.call('GET', '/api/quartalsreview/due', { token: H.advisorToken() });
  assert.equal(r.body.clients[0].open, false);
  assert.equal(r.body.clients[0].termin, '12.11.2026, 10 Uhr', 'Termin bleibt erhalten');
  assert.equal((await q.weeklyLines()).length, 0);
});

test('Eingaben prüfen und Zugriff nur für die Beraterin', async () => {
  const cur = q.quartalOf();
  assert.equal((await srv.call('PUT', `/api/quartalsreview/${biz.id}/2026-Q9`, { token: H.advisorToken(), body: { status: 'geplant' } })).status, 400);
  assert.equal((await srv.call('PUT', `/api/quartalsreview/${biz.id}/${cur}`, { token: H.advisorToken(), body: { status: 'kaputt' } })).status, 400);
  assert.equal((await srv.call('PUT', `/api/quartalsreview/${biz.id}/${cur}`, { token: H.clientToken(biz.id), body: { status: 'erledigt' } })).status, 403);
  assert.equal((await srv.call('GET', '/api/quartalsreview/due', { token: H.clientToken(biz.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/quartalsreview/${biz.id}/vorlage.docx`, { token: H.clientToken(biz.id) })).status, 403);
  assert.equal((await srv.call('GET', '/api/quartalsreview/due')).status, 401);
});

test('Gesprächsvorlage als Word', async () => {
  await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,1,'text-gen','Text Generator','Text')`, [biz.id]);
  const r = await srv.call('GET', `/api/quartalsreview/${biz.id}/vorlage.docx`, { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(/Quartalsreview_Business_AG/.test(r.headers.get('content-disposition')));
});
