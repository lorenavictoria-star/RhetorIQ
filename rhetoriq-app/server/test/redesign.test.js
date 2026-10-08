// Tests der neuen Redesign-Routen. Laufen gegen pg-mem und Attrappen (keine echte DB, KI oder Mail).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');

let srv;
const A = () => H.advisorToken();

test.before(async () => {
  await H.setupBase();
  srv = await H.startApp([
    ['/api/inquiries', require('../routes/inquiries').advisorRouter],
    ['/api/onboarding-drafts', require('../routes/onboardingDrafts')]
  ]);
});
test.after(async () => { await srv.close(); });

// ── S1 Onboarding-Entwürfe ─────────────────────────────────
test('S1 Entwürfe: ohne Token 401, Klient-Token 403', async () => {
  assert.equal((await srv.call('GET', '/api/onboarding-drafts')).status, 401);
  assert.equal((await srv.call('GET', '/api/onboarding-drafts', { token: H.clientToken(1) })).status, 403);
  assert.equal((await srv.call('POST', '/api/onboarding-drafts', { body: { firma: 'X' } })).status, 401);
});

test('S1 Entwurf anlegen, lesen, ändern, löschen', async () => {
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'Keller Bau AG', kontakt: 'Anna Keller', email: 'Anna@Keller.ch', sektor: 'kmu', anrede: 'du' } });
  assert.equal(c.status, 201);
  assert.equal(c.body.status, 'workshop_offen');
  assert.equal(c.body.email, 'anna@keller.ch');
  const id = c.body.id;
  const g = await srv.call('GET', `/api/onboarding-drafts/${id}`, { token: A() });
  assert.equal(g.body.firma, 'Keller Bau AG');
  const u = await srv.call('PUT', `/api/onboarding-drafts/${id}`, { token: A(), body: { schritt: 2, module: ['Text Generator', 'Unbekannt', 'Risiko-Scan'], briefing: { blick: ['a'] } } });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body.module, ['Text Generator', 'Risiko-Scan']);
  assert.equal(u.body.schritt, 2);
  assert.equal(u.body.firma, 'Keller Bau AG');
  const l = await srv.call('GET', '/api/onboarding-drafts', { token: A() });
  assert.ok(l.body.some(d => d.id === id));
  assert.equal((await srv.call('PUT', `/api/onboarding-drafts/${id}`, { token: A(), body: { anrede: 'xx' } })).status, 400);
  assert.equal((await srv.call('DELETE', `/api/onboarding-drafts/${id}`, { token: A() })).status, 200);
  assert.equal((await srv.call('GET', `/api/onboarding-drafts/${id}`, { token: A() })).status, 404);
});

test('S1 Entwurf aus Anfrage: Vorbefüllung, Status, draft_id in Liste', async () => {
  await require('../routes/inquiries').ensureTable();
  const { rows } = await H.pool.query(`INSERT INTO inquiries (name, company, email, message) VALUES ('Bea Muster','Muster GmbH','bea@muster.ch','Hallo') RETURNING id`);
  const qid = rows[0].id;
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: qid } });
  assert.equal(c.status, 201);
  assert.equal(c.body.kontakt, 'Bea Muster');
  assert.equal(c.body.firma, 'Muster GmbH');
  assert.equal(c.body.email, 'bea@muster.ch');
  const l = await srv.call('GET', '/api/inquiries', { token: A() });
  const q = l.body.find(x => x.id === qid);
  assert.equal(q.status, 'workshop_offen');
  assert.equal(q.draft_id, c.body.id);
  assert.equal(q.name, 'Bea Muster');
  assert.equal((await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: 9999 } })).status, 404);
});
