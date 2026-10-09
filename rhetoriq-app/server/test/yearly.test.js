const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('../test-support/harness');
const { pool } = require('../db');
const y = require('../lib/yearlyPlan');

let srv, c, calls = [];
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query("ALTER TABLE clients ADD COLUMN subscription_status TEXT DEFAULT 'trial'").catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('CREATE TABLE usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens INTEGER)').catch(() => {});
  c = await H.addClient('Jahres AG');
  const subs = require('../routes/subscriptions');
  subs._setStripe({ webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'sig-ok' || secret !== 'whsec_test') throw new Error('bad signature'); return JSON.parse(body.toString()); } }, paymentLinks: { create: async (o) => { calls.push(o); return { url: 'https://pay.test/x' }; } } });
  srv = await H.startApp([['/api/subscriptions', subs]]);
});
test.after(async () => { await srv.close(); });

test('Jahrespreise und Zuordnung', () => {
  assert.deepEqual(y.YEARLY.map(t => t.yearlyCents), [205200, 637200, 1609200]);
  assert.equal(y.resolveYearlyLimit(205200, 'chf'), 200000);
  assert.equal(y.resolveYearlyLimit(637200, 'CHF'), 750000);
  assert.equal(y.resolveYearlyLimit(1609200, 'chf'), 2000000);
  assert.equal(y.resolveYearlyLimit(1609200, 'eur'), undefined);
  assert.equal(y.resolveYearlyLimit(123, 'chf'), undefined);
  assert.equal(y.yearlyOfferFor(300000), null);
  assert.equal(y.yearlyOfferFor(1500000), null);
  assert.equal(y.yearlyOfferFor(null), null);
  const subs = require('../routes/subscriptions');
  assert.equal(subs.resolveTokenLimit(19000, 'chf'), 200000, 'Monatspreis unverändert');
  assert.equal(subs.resolveTokenLimit(637200, 'chf'), 750000);
});

test('yearly-link: Paket, Zugriff, Betrag', async () => {
  const none = await srv.call('POST', `/api/subscriptions/yearly-link/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(none.status, 400);
  await pool.query('UPDATE clients SET monthly_token_limit=750000 WHERE id=$1', [c.id]);
  const ok = await srv.call('POST', `/api/subscriptions/yearly-link/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.amountCents, 637200);
  const li = calls.at(-1).line_items[0].price_data;
  assert.equal(li.recurring.interval, 'year');
  assert.equal(li.unit_amount, 637200);
  assert.equal(calls.at(-1).metadata.type, 'yearly');
  assert.equal((await srv.call('POST', `/api/subscriptions/yearly-link/${c.id}`, { token: H.advisorToken() })).status, 200);
  const off = await srv.call('GET', `/api/subscriptions/yearly-offer/${c.id}`, { token: H.clientToken(c.id) });
  assert.deepEqual(off.body, { available: true, tier: 'Team', yearlyCents: 637200, monthlyCents: 59000 });
  const other = await H.addClient('Andere AG');
  assert.equal((await srv.call('GET', `/api/subscriptions/yearly-offer/${other.id}`, { token: H.clientToken(c.id) })).status, 403);
  assert.equal((await srv.call('POST', `/api/subscriptions/yearly-link/${other.id}`, { token: H.clientToken(c.id) })).status, 403);
  await pool.query('UPDATE clients SET monthly_token_limit=1500000 WHERE id=$1', [c.id]);
  assert.equal((await srv.call('POST', `/api/subscriptions/yearly-link/${c.id}`, { token: H.advisorToken() })).status, 400);
});

test('Webhook setzt Monatskontingent bei Jahreszahlung', async () => {
  const app = express();
  app.use('/api/subscriptions', require('../routes/subscriptions'));
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const ev = { id: 'evt_year_1', type: 'checkout.session.completed', data: { object: { metadata: { clientId: String(c.id) }, amount_total: 1609200, currency: 'chf', customer: 'cus_1' } } };
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig-ok' }, body: JSON.stringify(ev) });
  assert.equal(r.status, 200);
  const { rows } = await pool.query('SELECT monthly_token_limit, subscription_status FROM clients WHERE id=$1', [c.id]);
  assert.equal(rows[0].monthly_token_limit, 2000000);
  assert.equal(rows[0].subscription_status, 'active');
  s.close();
});
