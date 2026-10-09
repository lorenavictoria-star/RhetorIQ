const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const rt = require('../lib/reviewTime');

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  srv = await H.startApp([['/api/review-time', require('../routes/reviewTime')]]);
});
test.after(async () => { await srv.close(); });
const mk = async (clientId, label) => (await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,$2,'x') RETURNING id`, [clientId, label])).rows[0].id;

test('Mehraufwand: 15-Minuten-Takt zu CHF 180 pro Stunde', () => {
  assert.deepEqual(rt.extraFor(90, 90), { extraMinutes: 0, billedMinutes: 0, extraChf: 0 });
  assert.deepEqual(rt.extraFor(100, 90), { extraMinutes: 10, billedMinutes: 15, extraChf: 45 });
  assert.deepEqual(rt.extraFor(135, 90), { extraMinutes: 45, billedMinutes: 45, extraChf: 135 });
});

test('Minuten erfassen, Monatsübersicht, eigenes Kontingent', async () => {
  const r1 = await mk(a.id, 'E-Mail'), r2 = await mk(a.id, 'Rede');
  assert.equal((await srv.call('PUT', `/api/review-time/review/${r1}`, { token: H.clientToken(a.id), body: { minutes: 20 } })).status, 403);
  assert.equal((await srv.call('PUT', `/api/review-time/review/${r1}`, { token: H.advisorToken(), body: { minutes: 20 } })).status, 200);
  assert.equal((await srv.call('PUT', `/api/review-time/review/${r2}`, { token: H.advisorToken(), body: { minutes: 80 } })).status, 200);
  assert.equal((await srv.call('PUT', `/api/review-time/review/${r2}`, { token: H.advisorToken(), body: { minutes: 9999 } })).status, 400);
  const s = await srv.call('GET', `/api/review-time/client/${a.id}`, { token: H.advisorToken() });
  assert.equal(s.body.usedMinutes, 100);
  assert.equal(s.body.includedMinutes, 90, 'Standard Wachstum: 6 mal 15 Minuten');
  assert.equal(s.body.extraChf, 45);
  const t = await srv.call('PUT', `/api/review-time/client/${a.id}/included`, { token: H.advisorToken(), body: { minutes: 225 } });
  assert.equal(t.body.includedMinutes, 225);
  assert.equal(t.body.extraChf, 0);
});

test('CSV-Liste für die Rechnung', async () => {
  const csv = await rt.exportCsv(1, new Date().toISOString().slice(0, 7));
  assert.ok(csv.includes('Alpha AG'));
  assert.ok(csv.split('\r\n')[0].startsWith('﻿Klient;Monat'));
});

test('Klient sieht seine Übersicht mit Monatsabo und Mehraufwand obendrauf, andere Rollen nicht', async () => {
  await pool.query('UPDATE clients SET monthly_token_limit=$1 WHERE id=$2', [750000, b.id]);
  const r = await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'Brief','x') RETURNING id`, [b.id]);
  await srv.call('PUT', `/api/review-time/review/${r.rows[0].id}`, { token: H.advisorToken(), body: { minutes: 105 } });
  const m = await srv.call('GET', '/api/review-time/mine', { token: H.clientToken(b.id) });
  assert.equal(m.status, 200);
  assert.equal(m.body.aboChf, 590);
  assert.equal(m.body.extraMinutes, 15);
  assert.equal(m.body.extraChf, 45);
  assert.equal(m.body.totalChf, 635);
  assert.equal(m.body.rows[0].minutes, 105);
  assert.equal(m.body.rows[0].client_id, undefined);
  assert.equal((await srv.call('GET', '/api/review-time/mine', { token: H.clientToken(b.id, { clientUserId: (await pool.query('INSERT INTO client_users (client_id) VALUES ($1) RETURNING id', [b.id])).rows[0].id, clientUserRole: 'viewer' }) })).status, 403);
  assert.equal((await srv.call('GET', '/api/review-time/mine', { token: H.advisorToken() })).status, 403);
});

