// F-15: Webhook nur mit Secret und Signatur, Wiederholungsschutz, Kündigung über Kundennummer.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

const subs = require('../routes/subscriptions');
let srv, c, links;
test.before(async () => {
  await H.setupBase();
  for (const col of ['monthly_token_limit BIGINT', 'subscription_status TEXT DEFAULT \'trial\'', 'stripe_customer_id TEXT']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`CREATE TABLE usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens BIGINT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await require('../lib/schemaRedesign').ensureSchema();
  c = await H.addClient('Zahl AG');
  links = [];
  subs._setStripe({
    webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'sig-ok' || secret !== 'whsec_test') throw new Error('geheime Details der Signatur'); return JSON.parse(body.toString()); } },
    prices: { retrieve: async (id) => ({ id, recurring: id === 'price_monat' ? { interval: 'month' } : null }) },
    paymentLinks: { create: async (o) => { links.push(o); return { url: 'https://pay.test/x' }; } }
  });
  const express = require('express');
  const app = express();
  app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' })); // wie in index.js vor dem JSON-Parser
  app.use(express.json());
  app.use('/api/subscriptions', subs);
  const server = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  srv = {
    base, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
    call: async (method, url, { token, body } = {}) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    }
  };
});
test.after(async () => { await srv.close(); });

async function hook(ev, { sig = 'sig-ok', secret = 'whsec_test' } = {}) {
  if (secret) process.env.STRIPE_WEBHOOK_SECRET = secret; else delete process.env.STRIPE_WEBHOOK_SECRET;
  const r = await fetch(srv.base + '/api/subscriptions/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: JSON.stringify(ev) });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

const topup = (id) => ({ id, type: 'checkout.session.completed', data: { object: { metadata: { clientId: String(c.id), type: 'topup', tokens: '100000' }, amount_total: 4900, currency: 'chf' } } });
const sum = async () => Number((await pool.query('SELECT COALESCE(SUM(tokens),0)::bigint AS n FROM usage_topups WHERE client_id=$1', [c.id])).rows[0].n);

test('F-15 Ohne STRIPE_WEBHOOK_SECRET wird nichts angenommen', async () => {
  const r = await hook(topup('evt_a'), { secret: null });
  assert.equal(r.status, 400);
  assert.equal(await sum(), 0);
});

test('F-15 Falsche Signatur: 400 ohne interne Details', async () => {
  const r = await hook(topup('evt_b'), { sig: 'falsch' });
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.body).includes('geheime'));
  assert.equal(await sum(), 0);
});

test('F-15 Normalfall und Wiederholung: Top-up zählt genau einmal', async () => {
  assert.equal((await hook(topup('evt_c'))).status, 200);
  assert.equal(await sum(), 100000);
  const again = await hook(topup('evt_c'));
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(await sum(), 100000, 'zweite Zustellung ändert nichts');
  assert.equal((await hook(topup('evt_d'))).status, 200);
  assert.equal(await sum(), 200000, 'neues Ereignis zählt');
});

test('F-15 Kündigung: über Metadaten oder über gespeicherte Kundennummer', async () => {
  await pool.query(`UPDATE clients SET subscription_status='active', stripe_customer_id='cus_42' WHERE id=$1`, [c.id]);
  assert.equal((await hook({ id: 'evt_x', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_unbekannt', metadata: {} } } })).status, 200);
  assert.equal((await pool.query('SELECT subscription_status s FROM clients WHERE id=$1', [c.id])).rows[0].s, 'active', 'unbekannter Kunde ändert nichts');
  assert.equal((await hook({ id: 'evt_y', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_42', metadata: {} } } })).status, 200);
  assert.equal((await pool.query('SELECT subscription_status s FROM clients WHERE id=$1', [c.id])).rows[0].s, 'cancelled');
  await pool.query(`UPDATE clients SET subscription_status='active' WHERE id=$1`, [c.id]);
  assert.equal((await hook({ id: 'evt_z', type: 'customer.subscription.deleted', data: { object: { metadata: { clientId: String(c.id) } } } })).status, 200);
  assert.equal((await pool.query('SELECT subscription_status s FROM clients WHERE id=$1', [c.id])).rows[0].s, 'cancelled');
});

test('F-15 Payment Link: Klientennummer auch am wiederkehrenden Abo', async () => {
  const a = await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: { priceId: 'price_monat' } });
  assert.equal(a.status, 200);
  assert.equal(links.at(-1).subscription_data.metadata.clientId, String(c.id));
  await srv.call('POST', `/api/subscriptions/create-payment-link/${c.id}`, { token: H.advisorToken(), body: { priceId: 'price_einmal' } });
  assert.equal(links.at(-1).subscription_data, undefined, 'einmalige Preise ohne Abo-Daten');
});
