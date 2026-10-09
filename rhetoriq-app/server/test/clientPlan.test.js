const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  srv = await H.startApp([['/api/client-plan', require('../routes/clientPlan')]]);
});
test.after(async () => { await srv.close(); });

test('Empfohlenes Paket: Beraterin setzt, Klient liest nur das eigene', async () => {
  assert.equal((await srv.call('GET', `/api/client-plan/${a.id}`, { token: H.clientToken(a.id) })).body.plan, null);
  assert.equal((await srv.call('PUT', `/api/client-plan/${a.id}`, { token: H.advisorToken(), body: { plan: 'Team' } })).body.plan, 'team');
  assert.equal((await srv.call('GET', `/api/client-plan/${a.id}`, { token: H.clientToken(a.id) })).body.plan, 'team');
  assert.equal((await srv.call('GET', `/api/client-plan/${a.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('PUT', `/api/client-plan/${a.id}`, { token: H.clientToken(a.id), body: { plan: 'starter' } })).status, 403);
  assert.equal((await srv.call('PUT', `/api/client-plan/${a.id}`, { token: H.advisorToken(), body: { plan: 'gratis' } })).status, 400);
});
