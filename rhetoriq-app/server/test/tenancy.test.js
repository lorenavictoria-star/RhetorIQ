// F-14: Mandantentrennung zwischen zwei Beraterinnen (Freigaben, Ablage, Entwürfe, Inhalts-Abos, Zahlungen).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

let srv, mine, theirs, rv, rvOther, adv2, file, fileOther;
test.before(async () => {
  await H.setupBase();
  await pool.query(`INSERT INTO users (email, name) VALUES ('zwei@test.ch','Zwei')`);
  await pool.query(`CREATE TABLE content_subscriptions (id SERIAL PRIMARY KEY, client_id INTEGER, format TEXT, frequency TEXT, topic_hint TEXT, enabled BOOLEAN DEFAULT TRUE, last_sent_at TIMESTAMPTZ, UNIQUE (client_id, format))`);
  await pool.query(`ALTER TABLE clients ADD COLUMN subscription_status TEXT DEFAULT 'trial'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT`).catch(() => {});
  mine = await H.addClient('Meine AG');
  theirs = await H.addClient('Fremde AG');
  await pool.query('UPDATE clients SET advisor_id=2 WHERE id=$1', [theirs.id]);
  adv2 = H.advisorToken({ id: 2 });
  await require('../lib/schemaRedesign').ensureSchema();
  rv = (await pool.query(`INSERT INTO review_requests (client_id, original_text) VALUES ($1,'a') RETURNING id`, [mine.id])).rows[0].id;
  rvOther = (await pool.query(`INSERT INTO review_requests (client_id, original_text) VALUES ($1,'b') RETURNING id`, [theirs.id])).rows[0].id;
  file = (await pool.query(`INSERT INTO client_files (client_id, name, folder) VALUES ($1,'a.txt','unterlagen') RETURNING id`, [mine.id])).rows[0].id;
  fileOther = (await pool.query(`INSERT INTO client_files (client_id, name, folder) VALUES ($1,'b.txt','unterlagen') RETURNING id`, [theirs.id])).rows[0].id;
  srv = await H.startApp([
    ['/api/reviews', require('../routes/reviews')], ['/api/files', require('../routes/files')],
    ['/api/onboarding-drafts', require('../routes/onboardingDrafts')], ['/api/subscriptions', require('../routes/subscriptions')]
  ]);
});
test.after(async () => { await srv.close(); });

test('F-14 Freigaben: jede Beraterin sieht und ändert nur die eigenen', async () => {
  const l1 = await srv.call('GET', '/api/reviews', { token: H.advisorToken() });
  assert.deepEqual(l1.body.map(r => r.id), [rv]);
  const l2 = await srv.call('GET', '/api/reviews', { token: adv2 });
  assert.deepEqual(l2.body.map(r => r.id), [rvOther]);
  assert.equal((await srv.call('PUT', `/api/reviews/${rv}`, { token: adv2, body: { editedText: 'x', send: false } })).status, 404);
  assert.equal((await srv.call('DELETE', `/api/reviews/${rv}`, { token: adv2 })).status, 404);
  assert.equal((await srv.call('PUT', `/api/reviews/${rv}`, { token: H.advisorToken(), body: { editedText: 'x', send: false } })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/reviews/${rv}`, { token: H.advisorToken() })).status, 200);
});

test('F-14 Ablage: fremde Klienten- und Entwurfsdateien gesperrt', async () => {
  assert.equal((await srv.call('GET', `/api/files?client_id=${theirs.id}`, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('GET', `/api/files?client_id=${mine.id}`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('GET', `/api/files/zip?client_id=${theirs.id}`, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('GET', `/api/files/${fileOther}/download`, { token: H.advisorToken() })).status, 404);
  assert.equal((await srv.call('GET', `/api/files/${file}/download`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/files/${fileOther}`, { token: H.advisorToken() })).status, 404);
  assert.equal((await srv.call('DELETE', `/api/files/${file}`, { token: H.advisorToken() })).status, 200);
});

test('F-14 Entwürfe: nur eigene sichtbar', async () => {
  const d = await srv.call('POST', '/api/onboarding-drafts', { token: H.advisorToken(), body: { firma: 'Neu GmbH' } });
  assert.equal(d.status, 201);
  assert.equal((await srv.call('GET', `/api/onboarding-drafts/${d.body.id}`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('GET', `/api/onboarding-drafts/${d.body.id}`, { token: adv2 })).status, 404);
  assert.equal((await srv.call('PUT', `/api/onboarding-drafts/${d.body.id}`, { token: adv2, body: { firma: 'X' } })).status, 404);
  assert.equal((await srv.call('GET', '/api/onboarding-drafts', { token: adv2 })).body.length, 0);
  assert.equal((await srv.call('GET', '/api/onboarding-drafts', { token: H.advisorToken() })).body.length, 1);
});

test('F-14 Abos und Zahlungsstatus: fremde Klienten gesperrt', async () => {
  assert.equal((await srv.call('GET', `/api/subscriptions?clientId=${theirs.id}`, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('POST', '/api/subscriptions', { token: H.advisorToken(), body: { clientId: theirs.id, format: 'x' } })).status, 403);
  assert.equal((await srv.call('POST', '/api/subscriptions/mark-active/' + theirs.id, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('GET', '/api/subscriptions/status/' + theirs.id, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('POST', '/api/subscriptions', { token: H.advisorToken(), body: { clientId: mine.id, format: 'x' } })).status, 200);
  assert.equal((await srv.call('GET', `/api/subscriptions?clientId=${mine.id}`, { token: H.advisorToken() })).status, 200);
  assert.equal((await srv.call('POST', '/api/subscriptions/mark-active/' + mine.id, { token: H.advisorToken() })).status, 200);
  // Klient: nur die eigenen
  assert.equal((await srv.call('GET', `/api/subscriptions?clientId=${theirs.id}`, { token: H.clientToken(mine.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/subscriptions?clientId=${mine.id}`, { token: H.clientToken(mine.id) })).status, 200);
});
