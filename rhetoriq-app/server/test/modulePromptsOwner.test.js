// Modul-Anweisungen: Besitzprüfung (Klient A nicht bei B, Beraterin nur eigene Klienten).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

let srv, a, b, other;
test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE client_module_prompts (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT, instructions TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (client_id, module_key))`);
  await pool.query(`INSERT INTO users (email, name) VALUES ('zwei@test.ch','Zwei')`);
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
  other = await H.addClient('Fremd AG');
  await pool.query('UPDATE clients SET advisor_id=2 WHERE id=$1', [other.id]);
  srv = await H.startApp([['/api/module-prompts', require('../routes/modulePrompts')]]);
});
test.after(async () => { await srv.close(); });

test('Modul-Anweisungen: Beraterin für eigene Klienten, nicht für fremde', async () => {
  const w = await srv.call('POST', `/api/module-prompts/${a.id}/text-gen`, { token: H.advisorToken(), body: { instructions: 'Immer kurz.' } });
  assert.equal(w.status, 200);
  const r = await srv.call('GET', `/api/module-prompts/${a.id}/text-gen`, { token: H.advisorToken() });
  assert.equal(r.body.instructions, 'Immer kurz.');
  assert.equal((await srv.call('GET', `/api/module-prompts/${other.id}/text-gen`, { token: H.advisorToken() })).status, 403);
  assert.equal((await srv.call('POST', `/api/module-prompts/${other.id}/text-gen`, { token: H.advisorToken(), body: { instructions: 'x' } })).status, 403);
  assert.equal((await srv.call('POST', '/api/module-prompts/suggest', { token: H.advisorToken(), body: { clientId: other.id, moduleKey: 'x' } })).status, 403);
  assert.equal((await srv.call('POST', '/api/module-prompts/generate-starters', { token: H.advisorToken(), body: { clientId: other.id, brandVoice: 'x' } })).status, 403);
});

test('Modul-Anweisungen: Klient A liest und schreibt nicht bei B', async () => {
  assert.equal((await srv.call('GET', `/api/module-prompts/${b.id}/text-gen`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('POST', `/api/module-prompts/${b.id}/text-gen`, { token: H.clientToken(a.id), body: { instructions: 'x' } })).status, 403);
  assert.equal((await srv.call('GET', `/api/module-prompts/${a.id}/text-gen`, { token: H.clientToken(a.id) })).status, 403, 'Klienten brauchen den Zugriff nicht (nur Beraterin)');
});
