// F-07: harte Tagesgrenze, Standardkontingent für neue Klienten, Feldgrösse.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

process.env.COST_BRAKE_PLATFORM_DAILY_USD = '40';
process.env.COST_BRAKE_CLIENT_DAILY_USD = '10';
const { checkDailyCap } = require('../lib/costBrake');

let a, b;
test.before(async () => {
  await H.setupBase();
  await pool.query(`ALTER TABLE clients ADD COLUMN monthly_token_limit BIGINT`);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, client_id INTEGER, input_tokens BIGINT, output_tokens BIGINT, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
});
const log = (cid, usd) => pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens, cost_usd) VALUES ($1,1,1,$2)', [cid, usd]);
const cli = (id) => ({ role: 'client', clientId: id });

test('F-07 Normalfall: unter der Grenze geht alles durch', async () => {
  await log(a.id, 1);
  assert.equal((await checkDailyCap(cli(a.id), a.id)).ok, true);
});

test('F-07 Klient über 10 Dollar am Tag gesperrt, der andere nicht, Beraterin ausgenommen, Mail an Lorena', async () => {
  await log(a.id, 9.5);
  const r = await checkDailyCap(cli(a.id), a.id);
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'client');
  assert.match(r.error, /Tagesgrenze/);
  assert.equal((await checkDailyCap(cli(b.id), b.id)).ok, true);
  assert.equal((await checkDailyCap({ role: 'advisor', id: 1 }, a.id)).ok, true);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(H.brevoMails.some(m => /Kostenbremse/.test(m.subject)));
});

test('F-07 Plattform über 40 Dollar: alle Klienten gesperrt, Beraterin nicht', async () => {
  await log(b.id, 9);
  await log(null, 25);
  const r = await checkDailyCap(cli(b.id), b.id);
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'platform');
  assert.equal((await checkDailyCap({ role: 'advisor', id: 1 }, b.id)).ok, true);
});

test('F-07 Standardkontingent nur für neu angelegte Klienten, nicht für Enterprise', async () => {
  const { createClientRecord } = require('../lib/clientCreate');
  const n = await createClientRecord({ advisorId: 1, name: 'Neu AG ' + Date.now() });
  assert.equal(Number(n.row.monthly_token_limit), 200000);
  const e = await createClientRecord({ advisorId: 1, name: 'Gross AG ' + Date.now(), paket: 'enterprise' });
  assert.equal(e.row.monthly_token_limit == null, true);
  const { rows } = await pool.query('SELECT monthly_token_limit FROM clients WHERE id=$1', [a.id]);
  assert.equal(rows[0].monthly_token_limit, null, 'bestehende Klienten unverändert');
});

test('F-07 Eingabegrösse je Feld höchstens 60000 Zeichen', () => {
  const { capFields } = require('../routes/analyze')._internal;
  const d = capFields({ text: 'x'.repeat(100000), note: 'kurz', context: { a: 'y'.repeat(70000) } });
  assert.ok(d.text.length < 60200);
  assert.equal(d.note, 'kurz');
  assert.ok(d.context.a.length < 60200);
});
