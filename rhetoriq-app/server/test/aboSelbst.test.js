// Abo selbst verwalten: Selbstbuchung, 402-Sperre vor der Textgenerierung, Hinweise und Mails bei 80 und 100 Prozent.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;

const { DataType } = require('pg-mem');
H.mem.public.registerFunction({ name: 'date_trunc', args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz, implementation: (u, t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } });
process.env.ABO_PFLICHT_AB = '2026-01-01T00:00:00Z';

let srv, created = [], a, b, tm = {};
const set = (id, sql, ...p) => pool.query(`UPDATE clients SET ${sql} WHERE id=$1`, [id, ...p]);

test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  a = await H.addClient('Abo AG');
  b = await H.addClient('Andere AG');
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  for (const role of ['admin', 'editor', 'viewer']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@abo.ch', role, role])).rows[0].id;
  const subs = require('../routes/subscriptions');
  subs._setStripe({ paymentLinks: { create: async (p) => { created.push(p); return { url: 'https://stripe.test/l' }; } } });
  srv = await H.startApp([['/api/subscriptions', subs], ['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

const buche = (id, body, token) => srv.call('POST', `/api/subscriptions/selbst-buchen/${id}`, { token, body });

test('Selbstbuchung: Pakete mit Preis, Metadaten und Abo-Daten', async () => {
  const t = H.clientToken(a.id);
  for (const [k, cents] of [['stimme', 19000], ['team', 59000], ['business', 149000]]) {
    const r = await buche(a.id, { paket: k }, t);
    assert.equal(r.status, 200, k);
    const p = created.at(-1);
    assert.equal(p.line_items[0].price_data.unit_amount, cents);
    assert.equal(p.line_items[0].price_data.recurring.interval, 'month');
    assert.equal(p.metadata.clientId, String(a.id));
    assert.equal(p.subscription_data.metadata.clientId, String(a.id));
  }
  const j = await buche(a.id, { paket: 'team', jahr: true }, t);
  assert.equal(j.status, 200);
  assert.equal(created.at(-1).line_items[0].price_data.unit_amount, 637200);
  assert.equal(created.at(-1).line_items[0].price_data.recurring.interval, 'year');
});

test('Selbstbuchung: kein Enterprise, kein Stimm-Audit, kein Workshop', async () => {
  const t = H.clientToken(a.id), n = created.length;
  for (const k of ['enterprise', 'stimm-audit', 'workshop-team', 'workshop-business', 'gratis', '']) {
    assert.equal((await buche(a.id, { paket: k }, t)).status, 400, k);
  }
  assert.equal(created.length, n);
});

test('Selbstbuchung: nur Rolle admin und nur der eigene Klient', async () => {
  const n = created.length;
  assert.equal((await buche(a.id, { paket: 'team' }, H.clientToken(b.id))).status, 403, 'fremder Klient');
  assert.equal((await buche(a.id, { paket: 'team' }, H.clientToken(a.id, { clientUserId: tm.editor, clientUserRole: 'editor' }))).status, 403, 'Editor');
  assert.equal((await buche(a.id, { paket: 'team' }, H.clientToken(a.id, { clientUserId: tm.viewer, clientUserRole: 'viewer' }))).status, 403, 'Betrachter');
  assert.equal((await buche(a.id, { paket: 'team' }, H.advisorToken())).status, 403, 'Beraterin nutzt den Zahlungslink');
  assert.equal((await buche(a.id, { paket: 'team' }, H.clientToken(a.id, { readOnly: true, viewAs: true }))).status, 403, 'Ansicht des Klienten');
  assert.equal((await buche(a.id, { paket: 'team' })).status, 401);
  assert.equal(created.length, n);
  assert.equal((await buche(a.id, { paket: 'team' }, H.clientToken(a.id, { clientUserId: tm.admin, clientUserRole: 'admin' }))).status, 200, 'Team-Admin');
});

test('Selbstbuchung: Klient mit laufendem Abo bucht nicht doppelt', async () => {
  const c = await H.addClient('Hat Abo AG');
  await set(c.id, "subscription_status='active', monthly_token_limit=750000");
  assert.equal((await buche(c.id, { paket: 'business' }, H.clientToken(c.id))).status, 409);
});

test('Webhook: Abschluss der Selbstbuchung bucht active und Kontingent, fehlgeschlagene Zahlung setzt Hinweis', async () => {
  const express = require('express');
  const app = express();
  const subs = require('../routes/subscriptions');
  app.use('/api/subscriptions', subs);
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  subs._setStripe({ webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'ok') throw new Error('bad'); return JSON.parse(body.toString()); } } });
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const post = ev => fetch(`http://127.0.0.1:${s.address().port}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'ok' }, body: JSON.stringify(ev) });
  const c = await H.addClient('Neu AG');
  const ev = (id, type, o) => ({ id, type, data: { object: o } });
  assert.equal((await post(ev('e1', 'checkout.session.completed', { metadata: { clientId: String(c.id), type: 'selbstbuchung', angebot: 'team' }, amount_total: 59000, currency: 'chf', customer: 'cus_1' }))).status, 200);
  let r = (await pool.query('SELECT subscription_status s, monthly_token_limit l, stripe_customer_id c FROM clients WHERE id=$1', [c.id])).rows[0];
  assert.deepEqual([r.s, Number(r.l), r.c], ['active', 750000, 'cus_1']);
  assert.equal((await post(ev('e2', 'invoice.payment_failed', { customer: 'cus_1', subscription_details: { metadata: { clientId: String(c.id) } } }))).status, 200);
  r = (await pool.query('SELECT subscription_status s FROM clients WHERE id=$1', [c.id])).rows[0];
  assert.equal(r.s, 'past_due');
  assert.equal((await post(ev('e3', 'invoice.paid', { metadata: { clientId: String(c.id) }, amount_paid: 59000, currency: 'chf', customer: 'cus_1' }))).status, 200);
  r = (await pool.query('SELECT subscription_status s FROM clients WHERE id=$1', [c.id])).rows[0];
  assert.equal(r.s, 'active');
  s.close();
});

const gen = (token, clientId) => srv.call('POST', '/api/analyze', { token, body: { module: 'text-gen', clientId, data: { text: 'Einladung', tile: 'email' } } });

test('Sperre 402: Status trial ohne Zahlung, neuer Klient', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Ohne Abo AG');
  await set(c.id, "subscription_status='trial'");
  const r = await gen(H.clientToken(c.id));
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'Bitte schliessen Sie zuerst ein Abo ab.');
  assert.equal(r.body.aboRequired, true);
  assert.equal(r.body.grund, 'kein_abo');
  const stream = await srv.call('POST', '/api/analyze/stream', { token: H.clientToken(c.id), body: { module: 'text-gen', data: { text: 'x', tile: 'email' } } });
  assert.equal(stream.status, 402);
});

test('Sperre 402: pending_plan, gekündigt, Stimm-Audit abgelaufen', async () => {
  const c = await H.addClient('Gesperrt AG');
  await set(c.id, "subscription_status='pending_plan'");
  assert.equal((await gen(H.clientToken(c.id))).status, 402);
  await set(c.id, "subscription_status='cancelled'");
  const k = await gen(H.clientToken(c.id));
  assert.equal(k.status, 402);
  assert.equal(k.body.subscriptionCancelled, true);
  await set(c.id, "subscription_status='active', zugang_bis = NOW() - INTERVAL '1 day'");
  const ab = await gen(H.clientToken(c.id));
  assert.equal(ab.status, 402);
  assert.equal(ab.body.grund, 'audit_abgelaufen');
});

test('Kein 402: Abo aktiv, Stimm-Audit läuft, früherer Klient, Zahlung fehlgeschlagen, Beraterin', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Aktiv AG');
  await set(c.id, "subscription_status='active', monthly_token_limit=200000");
  assert.equal((await gen(H.clientToken(c.id))).status, 200);
  await set(c.id, "zugang_bis = NOW() + INTERVAL '10 days'");
  assert.equal((await gen(H.clientToken(c.id))).status, 200, 'Stimm-Audit-Zeitraum');
  await set(c.id, "zugang_bis = NULL, subscription_status='past_due'");
  assert.equal((await gen(H.clientToken(c.id))).status, 200, 'Zugang bleibt bei fehlgeschlagener Zahlung');
  const alt = await H.addClient('Alt AG');
  await set(alt.id, "subscription_status='trial', created_at = '2025-06-01T00:00:00Z'");
  assert.equal((await gen(H.clientToken(alt.id))).status, 200, 'Testklient von früher bleibt nutzbar');
  const neu = await H.addClient('Trial neu AG');
  await set(neu.id, "subscription_status='trial'");
  assert.equal((await gen(H.advisorToken(), neu.id)).status, 200, 'Beraterin unberührt');
});

test('Kontingent erreicht bleibt 429 mit Hinweis auf Zusatzpaket', async () => {
  const c = await H.addClient('Voll AG');
  await set(c.id, "subscription_status='active', monthly_token_limit=1000");
  await pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,900,200)', [c.id]);
  const r = await gen(H.clientToken(c.id));
  assert.equal(r.status, 429);
  assert.equal(r.body.quotaExceeded, true);
});

test('Übersicht: Nutzung in Texten und Hinweise bei 80 und 100 Prozent', async () => {
  const c = await H.addClient('Hinweis AG');
  await set(c.id, "subscription_status='active', monthly_token_limit=200000");
  const t = H.clientToken(c.id);
  const get = () => srv.call('GET', `/api/subscriptions/abo/${c.id}`, { token: t });
  let r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.body.nutzung.kontingent, 40);
  assert.equal(r.body.nutzung.verbraucht, 0);
  assert.equal(r.body.nutzung.verbleibend, 40);
  assert.equal(r.body.hinweise.length, 0);
  assert.deepEqual(r.body.pakete.map(p => [p.key, p.amountCents, p.texte, p.nutzer]), [['stimme', 19000, 40, 1], ['team', 59000, 150, 5], ['business', 149000, 400, 15]]);
  assert.equal(r.body.paket.name, 'Stimme');
  await pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,150000,20000)', [c.id]);
  r = await get();
  assert.equal(r.body.hinweise[0].art, 'kontingent80');
  assert.equal(r.body.nutzung.verbleibend, 6);
  await pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,30000,0)', [c.id]);
  r = await get();
  assert.equal(r.body.hinweise[0].art, 'kontingent100');
  assert.equal(r.body.nutzung.verbleibend, 0);
  // Zusatzpaket erweitert das Kontingent des Monats
  await pool.query('INSERT INTO usage_topups (client_id, tokens) VALUES ($1,100000)', [c.id]);
  r = await get();
  assert.equal(r.body.nutzung.kontingent, 60);
  assert.equal(r.body.nutzung.zusatzTexte, 20);
  assert.equal(r.body.hinweise.length, 0);
  assert.equal((await srv.call('GET', `/api/subscriptions/abo/${c.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/subscriptions/abo/${c.id}`, { token: H.clientToken(c.id, { clientUserId: tm.editor, clientUserRole: 'editor' }) })).status, 403);
});

test('Hinweis ohne Abo und bei fehlgeschlagener Zahlung', async () => {
  const c = await H.addClient('Ohne AG');
  await set(c.id, "subscription_status='trial'");
  let r = await srv.call('GET', `/api/subscriptions/abo/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(r.body.aktiv, false);
  assert.equal(r.body.hinweise[0].art, 'kein_abo');
  await set(c.id, "subscription_status='past_due', monthly_token_limit=200000");
  r = await srv.call('GET', `/api/subscriptions/abo/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(r.body.hinweise[0].art, 'zahlung');
});

test('Mail bei 80 und 100 Prozent: je Schwelle und Monat einmal, an Hauptadresse', async () => {
  const { pruefeSchwellen } = require('../lib/abo');
  const c = await H.addClient('Mail AG');
  await set(c.id, "subscription_status='active', monthly_token_limit=10000, email='chef@mail-ag.ch'");
  H.brevoMails.length = 0;
  await pruefeSchwellen(c.id);
  assert.equal(H.brevoMails.length, 0, 'unter 80 Prozent keine Mail');
  await pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,8000,500)', [c.id]);
  await pruefeSchwellen(c.id); await pruefeSchwellen(c.id);
  assert.equal(H.brevoMails.length, 1);
  assert.equal(H.brevoMails[0].to, 'chef@mail-ag.ch');
  assert.match(H.brevoMails[0].subject, /80 Prozent/);
  await pool.query('INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,2000,0)', [c.id]);
  await pruefeSchwellen(c.id); await pruefeSchwellen(c.id);
  assert.equal(H.brevoMails.length, 2);
  assert.match(H.brevoMails[1].subject, /aufgebraucht/);
});

test('Enterprise ist auch über choose-plan und upgrade-link nicht selbst buchbar', async () => {
  const c = await H.addClient('Stufe AG');
  const n = created.length;
  const ch = await srv.call('POST', `/api/subscriptions/choose-plan/${c.id}`, { token: H.clientToken(c.id), body: { tier: 'Enterprise' } });
  assert.equal(ch.status, 400);
  await set(c.id, "monthly_token_limit=2000000, subscription_status='active'");
  const up = await srv.call('POST', `/api/subscriptions/upgrade-link/${c.id}`, { token: H.clientToken(c.id) });
  assert.equal(up.status, 400);
  assert.equal(created.length, n);
});
