const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, c, created = [];
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query("ALTER TABLE clients ADD COLUMN subscription_status TEXT DEFAULT 'trial'").catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  c = await H.addClient('Angebot AG');
  const subs = require('../routes/subscriptions');
  subs._setStripe({
    paymentLinks: { create: async (p) => { created.push(p); return { url: 'https://stripe.test/link' }; } },
    webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'sig-ok' || secret !== 'whsec_test') throw new Error('bad'); return JSON.parse(body.toString()); } }
  });
  srv = await H.startApp([['/api/subscriptions', subs]]);
});
test.after(async () => { await srv.close(); });

test('Zahlungslink aus eingebautem Angebot, ohne Preise in Stripe', async () => {
  const none = await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: {} });
  assert.equal(none.status, 400);
  const bad = await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: { angebot: 'gratis' } });
  assert.equal(bad.status, 400);
  const abo = await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: { angebot: 'team' } });
  assert.equal(abo.status, 200);
  assert.equal(created[0].line_items[0].price_data.unit_amount, 59000);
  assert.equal(created[0].line_items[0].price_data.recurring.interval, 'month');
  assert.equal(created[0].subscription_data.metadata.clientId, String(c.id));
  const audit = await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: { angebot: 'stimm-audit' } });
  assert.equal(audit.status, 200);
  assert.equal(created[1].line_items[0].price_data.unit_amount, 95000);
  assert.equal(created[1].line_items[0].price_data.recurring, undefined);
  assert.equal(created[1].metadata.type, 'einrichtung');
  assert.equal((await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.clientToken(c.id), body: { angebot: 'team' } })).status, 403);
  const list = await srv.call('GET', '/api/subscriptions/angebote', { token: H.advisorToken() });
  assert.ok(list.body.some(a => a.key === 'stimm-audit' && a.amountCents === 95000));
});

test('Webhook: Stimm-Audit schaltet 30 Tage mit 40 Texten frei, Workshop ändert das Abo nicht', async () => {
  const app = express();
  app.use('/api/subscriptions', require('../routes/subscriptions'));
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const post = ev => fetch(`http://127.0.0.1:${s.address().port}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig-ok' }, body: JSON.stringify(ev) });
  const mk = (id, angebot, amount) => ({ id, type: 'checkout.session.completed', data: { object: { metadata: { clientId: String(c.id), type: 'einrichtung', angebot }, amount_total: amount, currency: 'chf', customer: 'cus_a' } } });
  assert.equal((await post(mk('evt_ws', 'workshop-team', 390000))).status, 200);
  let r = await pool.query('SELECT monthly_token_limit, subscription_status FROM clients WHERE id=$1', [c.id]);
  assert.notEqual(r.rows[0].monthly_token_limit, 200000);
  assert.equal((await post(mk('evt_au', 'stimm-audit', 95000))).status, 200);
  r = await pool.query('SELECT monthly_token_limit, subscription_status FROM clients WHERE id=$1', [c.id]);
  assert.equal(r.rows[0].monthly_token_limit, 200000);
  assert.equal(r.rows[0].subscription_status, 'active');
  const z = await pool.query(`SELECT zugang_bis FROM clients WHERE id=$1`, [c.id]);
  const tage = (new Date(z.rows[0].zugang_bis) - Date.now()) / 86400000;
  assert.ok(tage > 29 && tage < 31, 'Zugang endet nach 30 Tagen');
  s.close();
});
