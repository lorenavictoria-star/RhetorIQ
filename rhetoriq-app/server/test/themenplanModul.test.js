// Themenplan als Zusatzmodul «Automatisch Themen und Ideen senden»: Schalter, Kauf, Webhook, Cron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../test-support/harness');
const { pool } = H;
const { runThemenplanJob } = require('../jobs/themenplan');

let srv, wh, a, b, created = [], tm = {};
const NOW = new Date('2026-11-01T06:00:00+01:00');
const flag = async (id) => (await pool.query('SELECT themenplan_aktiv t, subscription_status s, monthly_token_limit l FROM clients WHERE id=$1', [id])).rows[0];

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN included_minutes INTEGER').catch(() => {});
  await pool.query('CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  const { DataType } = require('pg-mem');
  try { H.mem.public.registerFunction({ name: 'date_trunc', args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz, implementation: (u, t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } }); } catch { /* schon registriert */ }
  await pool.query('CREATE TABLE IF NOT EXISTS usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens BIGINT, created_at TIMESTAMPTZ DEFAULT NOW())');
  a = await H.addClient('Modul AG'); b = await H.addClient('Fremd AG');
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  for (const role of ['admin', 'editor']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@m.ch', role, role])).rows[0].id;
  await require('../lib/schemaRedesign').ensureSchema();
  const subs = require('../routes/subscriptions');
  subs._setStripe({
    paymentLinks: { create: async (p) => { created.push(p); return { url: 'https://stripe.test/tp' }; } },
    webhooks: { constructEvent: (body, sig) => { if (sig !== 'ok') throw new Error('bad'); return JSON.parse(body.toString()); } }
  });
  srv = await H.startApp([['/api/subscriptions', subs], ['/api/themenplan', require('../routes/themenplan')]]);
  const express = require('express');
  const app = express();
  app.use('/api/subscriptions', subs);
  wh = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});
test.after(async () => { await srv.close(); wh.close(); });

const post = (ev) => fetch(`http://127.0.0.1:${wh.address().port}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'ok' }, body: JSON.stringify(ev) });
const ev = (id, type, o) => ({ id, type, data: { object: o } });
const kauf = (id, token) => srv.call('POST', `/api/subscriptions/themenplan-link/${id}`, { token, body: {} });

test('Modul-Schalter der Beraterin ohne Zahlung, Datenquelle bleibt themenplan_aktiv', async () => {
  const t = H.advisorToken();
  assert.equal((await srv.call('PUT', `/api/themenplan/client/${a.id}`, { token: t, body: { aktiv: true } })).status, 200);
  assert.equal((await flag(a.id)).t, true);
  const g = await srv.call('GET', `/api/themenplan/client/${a.id}`, { token: t });
  assert.equal(g.body.aktiv, true);
  assert.equal(g.body.preisChf, 150);
  assert.equal((await srv.call('PUT', `/api/themenplan/client/${a.id}`, { token: t, body: { aktiv: false } })).status, 200);
  assert.equal((await flag(a.id)).t, false);
});

test('Kauf: Zahlungslink wiederkehrend monatlich mit inline price_data und Metadaten', async () => {
  const r = await kauf(a.id, H.clientToken(a.id));
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://stripe.test/tp');
  const p = created.at(-1);
  assert.equal(p.line_items[0].price_data.unit_amount, 15000);
  assert.equal(p.line_items[0].price_data.currency, 'chf');
  assert.equal(p.line_items[0].price_data.recurring.interval, 'month');
  assert.equal(p.metadata.clientId, String(a.id));
  assert.equal(p.metadata.type, 'themenplan');
  assert.equal(p.subscription_data.metadata.type, 'themenplan');
  assert.equal(p.subscription_data.metadata.clientId, String(a.id));
  assert.equal((await flag(a.id)).t, false, 'aktiv erst nach der Zahlung');
});

test('Kauf: nur Rolle admin des eigenen Klienten', async () => {
  const n = created.length;
  assert.equal((await kauf(a.id, H.clientToken(b.id))).status, 403, 'fremder Klient');
  assert.equal((await kauf(a.id, H.clientToken(a.id, { clientUserId: tm.editor, clientUserRole: 'editor' }))).status, 403, 'Editor');
  assert.equal((await kauf(a.id, H.advisorToken())).status, 403, 'Beraterin');
  assert.equal((await kauf(a.id, H.clientToken(a.id, { readOnly: true, viewAs: true }))).status, 403, 'Ansicht des Klienten');
  assert.equal((await kauf(a.id)).status, 401);
  assert.equal(created.length, n);
  assert.equal((await kauf(a.id, H.clientToken(a.id, { clientUserId: tm.admin, clientUserRole: 'admin' }))).status, 200, 'Team-Admin');
});

test('Webhook: Zahlung setzt themenplan_aktiv, Paket und Kontingent bleiben unberührt', async () => {
  await pool.query(`UPDATE clients SET subscription_status='active', monthly_token_limit=750000 WHERE id=$1`, [a.id]);
  const meta = { clientId: String(a.id), type: 'themenplan' };
  assert.equal((await post(ev('t1', 'checkout.session.completed', { metadata: meta, amount_total: 15000, currency: 'chf', customer: 'cus_tp' }))).status, 200);
  let f = await flag(a.id);
  assert.deepEqual([f.t, f.s, Number(f.l)], [true, 'active', 750000]);
  // Verlängerung über die Rechnung (Metadaten am Abo)
  await pool.query('UPDATE clients SET themenplan_aktiv=FALSE WHERE id=$1', [a.id]);
  assert.equal((await post(ev('t2', 'invoice.paid', { amount_paid: 15000, currency: 'chf', customer: 'cus_tp', subscription_details: { metadata: meta } }))).status, 200);
  f = await flag(a.id);
  assert.deepEqual([f.t, f.s, Number(f.l)], [true, 'active', 750000]);
  // fehlgeschlagene Zahlung des Zusatzmoduls setzt das Paket nicht auf past_due
  assert.equal((await post(ev('t3', 'invoice.payment_failed', { customer: 'cus_tp', subscription_details: { metadata: meta } }))).status, 200);
  assert.equal((await flag(a.id)).s, 'active');
});

test('Webhook: Kündigung und Zahlungsausfall nehmen es zurück, das Paket bleibt', async () => {
  const meta = { clientId: String(a.id), type: 'themenplan' };
  assert.equal((await post(ev('t4', 'customer.subscription.deleted', { metadata: meta, customer: 'cus_tp' }))).status, 200);
  let f = await flag(a.id);
  assert.deepEqual([f.t, f.s], [false, 'active']);
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [a.id]);
  assert.equal((await post(ev('t5', 'customer.subscription.updated', { metadata: meta, status: 'past_due' }))).status, 200);
  assert.equal((await flag(a.id)).t, true, 'Mahnfrist läuft noch');
  assert.equal((await post(ev('t6', 'customer.subscription.updated', { metadata: meta, status: 'unpaid' }))).status, 200);
  f = await flag(a.id);
  assert.deepEqual([f.t, f.s], [false, 'active']);
});

test('Kauf: bereits aktiv ergibt 409', async () => {
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [a.id]);
  assert.equal((await kauf(a.id, H.clientToken(a.id))).status, 409);
  await pool.query('UPDATE clients SET themenplan_aktiv=FALSE WHERE id=$1', [a.id]);
});

test('Abo-Übersicht nennt das Zusatzmodul mit Preis und Stand', async () => {
  const r = await srv.call('GET', `/api/subscriptions/abo/${a.id}`, { token: H.clientToken(a.id) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.themenplan, { aktiv: false, amountCents: 15000 });
});

test('Cron: nur aktive Klienten, auch nach Kauf und Kündigung', async () => {
  H.ai.reply = (o) => (/Newsletter-Entwurf/.test(o.messages[0].content) ? 'BETREFF: Herbst\nVORSCHAU: kurz\nText.' : JSON.stringify({ themen: Array.from({ length: 9 }, (_, i) => ({ titel: `Thema ${i + 1}`, anlass: 'Herbst', kernaussage: 'Ein Satz.', textart: 'Newsletter', termin: '10.11.2026' })) }));
  await pool.query('UPDATE clients SET themenplan_aktiv=FALSE');
  assert.deepEqual(await runThemenplanJob({ now: NOW }), [], 'niemand aktiv');
  await post(ev('t7', 'checkout.session.completed', { metadata: { clientId: String(a.id), type: 'themenplan' }, customer: 'cus_tp' }));
  const out = await runThemenplanJob({ now: NOW });
  assert.deepEqual(out.map(x => x.clientId), [a.id]);
});

test('Oberfläche: Zusatzmodul im Onboarding, in «Module anpassen» und unter «Abo verwalten», Block vor rq-lernkurve-js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.ok(html.includes('Automatisch Themen und Ideen senden · CHF 150 pro Monat'));
  const i = html.indexOf('<script id="rq-themenplanmodul-js">');
  assert.ok(i > 0 && i < html.indexOf('<script id="rq-lernkurve-js">'));
  const blk = html.slice(i, html.indexOf('</script>', i));
  assert.ok(blk.includes('openModuleConfig') && blk.includes('saveModuleConfig') && blk.includes('themenplan-link') && blk.includes('Aktiv, Details bei Modulen'));
  assert.ok(!/[–—]/.test(blk), 'keine Gedankenstriche');
  assert.ok(!html.includes('<script id="rq-themenplan-js">'));
  assert.ok(html.includes('["Automatisch Themen und Ideen senden","Send topics and ideas automatically"]'));
});
