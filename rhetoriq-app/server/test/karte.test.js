const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('../test-support/harness');
const { pool } = require('../db');
const rt = require('../lib/reviewTime');

let srv, c, other, calls = [];
const month = new Date().toISOString().slice(0, 7);
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query("ALTER TABLE clients ADD COLUMN subscription_status TEXT DEFAULT 'trial'").catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('CREATE TABLE usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens INTEGER)').catch(() => {});
  c = await H.addClient('Karten AG'); other = await H.addClient('Fremd AG');
  const subs = require('../routes/subscriptions');
  subs._setStripe({ webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'sig-ok' || secret !== 'whsec_test') throw new Error('bad signature'); return JSON.parse(body.toString()); } }, paymentLinks: { create: async (o) => { calls.push(o); return { url: 'https://pay.test/k' }; } } });
  srv = await H.startApp([['/api/subscriptions', subs], ['/api/review-time', require('../routes/reviewTime')]]);
});
test.after(async () => { await srv.close(); });

test('cardsApply: älteste Karte zuerst, Rest in CHF', () => {
  const cards = [
    { id: 2, minuten_gesamt: 300, minuten_verbraucht: 0, gekauft_am: '2026-02-01' },
    { id: 1, minuten_gesamt: 300, minuten_verbraucht: 280, gekauft_am: '2026-01-01' },
  ];
  const a = rt.cardsApply(50, cards);
  assert.equal(a.kartenMinuten, 50);
  assert.deepEqual(a.parts, [{ id: 1, minutes: 20 }, { id: 2, minutes: 30 }]);
  assert.equal(a.extraChf, 0);
  assert.equal(a.guthabenMinuten, 320);
  const b = rt.cardsApply(340, [{ id: 1, minuten_gesamt: 300, minuten_verbraucht: 0, gekauft_am: '2026-01-01' }]);
  assert.equal(b.kartenMinuten, 300);
  assert.equal(b.restMinutes, 40);
  assert.equal(b.billedMinutes, 45);
  assert.equal(b.extraChf, 135);
  const n = rt.cardsApply(20, []);
  assert.equal(n.kartenMinuten, 0);
  assert.equal(n.extraChf, 90);
});

test('karte-link: Zugriff und Betrag', async () => {
  const ok = await srv.call('POST', `/api/subscriptions/karte-link/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(ok.status, 200);
  assert.equal(calls.at(-1).line_items[0].price_data.unit_amount, 69000);
  assert.deepEqual([calls.at(-1).metadata.type, calls.at(-1).metadata.clientId], ['karte', String(c.id)]);
  assert.equal((await srv.call('POST', `/api/subscriptions/karte-link/${c.id}`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('POST', `/api/subscriptions/karte-link/${other.id}`, { token: H.clientToken(c.id) })).status, 403);
  const uid = (await pool.query('INSERT INTO client_users (client_id) VALUES ($1) RETURNING id', [c.id])).rows[0].id;
  assert.equal((await srv.call('POST', `/api/subscriptions/karte-link/${c.id}`, { token: H.clientToken(c.id, { clientUserId: uid, clientUserRole: 'viewer' }) })).status, 403);
  assert.equal((await srv.call('POST', `/api/subscriptions/karte-link/${c.id}`, {})).status, 401);
});

async function hook(ev) {
  const app = express();
  app.use('/api/subscriptions', require('../routes/subscriptions'));
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig-ok' }, body: JSON.stringify(ev) });
  s.close();
  return r.status;
}

test('Webhook legt eine Karte an, doppelte Zustellung keine zweite', async () => {
  const ev = { id: 'evt_karte_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', metadata: { clientId: String(c.id), type: 'karte' }, amount_total: 69000, currency: 'chf' } } };
  assert.equal(await hook(ev), 200);
  assert.equal(await hook(ev), 200);
  const { rows } = await pool.query('SELECT * FROM ueberarbeitungskarten WHERE client_id=$1', [c.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minuten_gesamt, 300);
  const { rows: cl } = await pool.query('SELECT monthly_token_limit FROM clients WHERE id=$1', [c.id]);
  assert.equal(cl[0].monthly_token_limit, null, 'Kauf ändert das Abo nicht');
});

test('Anzeige mit Karte, Abschluss bucht einmal, Wiederholung ohne Doppelbuchung', async () => {
  await pool.query('UPDATE clients SET included_minutes=30 WHERE id=$1', [c.id]);
  const rid = (await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'E-Mail','x') RETURNING id`, [c.id])).rows[0].id;
  assert.equal((await srv.call('PUT', `/api/review-time/review/${rid}`, { token: H.advisorToken(), body: { minutes: 100 } })).status, 200);
  const before = await srv.call('GET', `/api/review-time/client/${c.id}?month=${month}`, { token: H.advisorToken() });
  assert.equal(before.body.extraMinutes, 70);
  assert.equal(before.body.kartenMinuten, 70);
  assert.equal(before.body.extraChf, 0);
  assert.equal(before.body.extraChfVorKarte, 225);
  assert.equal(before.body.guthabenMinuten, 300, 'Anzeige verbraucht nichts');
  const mine = await srv.call('GET', '/api/review-time/mine', { token: H.clientToken(c.id) });
  assert.equal(mine.body.guthabenMinuten, 300);
  assert.equal(mine.body.kartenMinuten, 70);
  assert.equal((await srv.call('POST', `/api/review-time/client/${c.id}/abschliessen?month=${month}`, { token: H.clientToken(c.id) })).status, 403);
  const a1 = await srv.call('POST', `/api/review-time/client/${c.id}/abschliessen?month=${month}`, { token: H.advisorToken() });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.neu, true);
  const a2 = await srv.call('POST', `/api/review-time/client/${c.id}/abschliessen?month=${month}`, { token: H.advisorToken() });
  assert.equal(a2.body.neu, false);
  const { rows } = await pool.query('SELECT minuten_verbraucht FROM ueberarbeitungskarten WHERE client_id=$1', [c.id]);
  assert.equal(rows[0].minuten_verbraucht, 70);
  const after = await srv.call('GET', `/api/review-time/client/${c.id}?month=${month}`, { token: H.advisorToken() });
  assert.equal(after.body.abgeschlossen, true);
  assert.equal(after.body.kartenMinuten, 70);
  assert.equal(after.body.guthabenMinuten, 230);
  assert.equal(after.body.extraChf, 0);
  const csv = await rt.exportCsv(1, month);
  assert.ok(csv.includes('Karte abgezogen Minuten'));
  assert.ok(csv.includes(';70;0.00;'));
});
