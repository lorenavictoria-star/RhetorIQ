// KI-Wächter und Statusendpunkt: Attrappen für KI und Mail, keine echten Aufrufe.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { runWaechter } = require('../jobs/ki-waechter');
const { getStatus } = require('../lib/systemStatus');

let srv;
test.before(async () => {
  await H.setupBase();
  srv = await H.startApp([['/api/status', require('../routes/status')]]);
});
test.after(async () => { await srv.close(); });

test('Anfrage ist winzig und im Nutzungsprotokoll als waechter markiert', async () => {
  H.ai.fail = false; H.ai.calls.length = 0; H.ai.reply = 'ok';
  const r = await runWaechter();
  assert.equal(r.ok, true);
  const c = H.ai.calls[0];
  assert.equal(c.maxTokens, 5);
  assert.equal(c.meter.module, 'waechter');
  assert.match(c.model, /haiku/);
});

test('Zwei Fehler lösen noch nichts aus, der dritte schon (eine Mail pro Störung)', async () => {
  H.mails.length = 0; H.ai.fail = true;
  await runWaechter(); await runWaechter();
  assert.equal(H.mails.length, 0);
  assert.equal((await srv.call('GET', '/api/status')).body.ki, 'ok');
  const r3 = await runWaechter();
  assert.equal(r3.stoerung, true);
  assert.equal(H.mails.length, 1);
  assert.match(H.mails[0].subject, /gestört/);
  await runWaechter(); await runWaechter();
  assert.equal(H.mails.length, 1, 'keine zweite Mail bei derselben Störung');
  assert.equal(await getStatus('ki_stoerung'), true);
  const s = await srv.call('GET', '/api/status');
  assert.deepEqual(s.body, { ki: 'gestoert' }, 'ohne Details');
});

test('Wiederkehr entwarnt per Mail und löscht den Hinweis', async () => {
  H.ai.fail = false;
  const r = await runWaechter();
  assert.equal(r.entwarnung, true);
  assert.equal(H.mails.length, 2);
  assert.match(H.mails[1].subject, /Entwarnung/);
  assert.deepEqual((await srv.call('GET', '/api/status')).body, { ki: 'ok' });
});

test('Reservekonto-Schalter: nur Beraterin, Wert wird gespeichert', async () => {
  const c = await H.addClient('Reservefirma');
  assert.equal((await srv.call('PUT', '/api/status/reserve', { token: H.clientToken(c.id), body: { an: true } })).status, 403);
  assert.equal((await srv.call('GET', '/api/status/reserve', { token: H.advisorToken() })).body.erzwingen, false);
  const r = await srv.call('PUT', '/api/status/reserve', { token: H.advisorToken(), body: { an: true } });
  assert.equal(r.body.erzwingen, true);
  assert.deepEqual(await getStatus('ai_reserve_erzwingen'), { an: true });
  assert.equal((await srv.call('GET', '/api/status/reserve', { token: H.advisorToken() })).body.erzwingen, true);
  await srv.call('PUT', '/api/status/reserve', { token: H.advisorToken(), body: { an: false } });
  assert.deepEqual(await getStatus('ai_reserve_erzwingen'), { an: false });
});

test('Hinweis von Hand: nur Beraterin, mit eigenem Text', async () => {
  const c = await H.addClient('Statusfirma');
  assert.equal((await srv.call('PUT', '/api/status/manuell', { token: H.clientToken(c.id), body: { an: true } })).status, 403);
  assert.equal((await srv.call('PUT', '/api/status/manuell', { body: { an: true } })).status, 401);
  const r = await srv.call('PUT', '/api/status/manuell', { token: H.advisorToken(), body: { an: true, text: 'Wartung bis 14 Uhr.' } });
  assert.equal(r.status, 200);
  const s = await srv.call('GET', '/api/status');
  assert.equal(s.body.ki, 'gestoert');
  assert.equal(s.body.hinweis, 'Wartung bis 14 Uhr.');
  await srv.call('PUT', '/api/status/manuell', { token: H.advisorToken(), body: { an: false } });
  assert.deepEqual((await srv.call('GET', '/api/status')).body, { ki: 'ok' });
});
