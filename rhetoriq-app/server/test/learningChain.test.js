// Regressionstest zur ganzen Lernkette: Lernstand je Textart speichern, beim Erzeugen lesen, Klienten trennen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const H = require('../test-support/harness');
const { setupGenerate, systemText } = require('../test-support/genSetup');

let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

test('Lernkette: Lernstand unter text-gen-email erreicht den Block, andere Klienten und Textarten nicht', async () => {
  const { getFeedbackLearningsBlock } = require('../routes/analyze')._internal;
  const a = await H.addClient('Kette A AG');
  const b = await H.addClient('Kette B AG');
  await H.pool.query(
    `INSERT INTO client_feedback_learnings (client_id, module_key, category, summary) VALUES
     ($1,'text-gen-email','TON','Gelernter Satz Alpha.'),
     ($1,'text-gen-linkedin','TON','Fremde Textart Beta.'),
     ($2,'text-gen-email','TON','Fremder Klient Gamma.')`, [a.id, b.id]);
  const block = await getFeedbackLearningsBlock(a.id, ['text-gen', 'text-gen-email']);
  assert.ok(block.includes('Gelernter Satz Alpha.'));
  assert.ok(!block.includes('Beta'), 'andere Textart bleibt draussen');
  assert.ok(!block.includes('Gamma'), 'anderer Klient bleibt draussen');
});

test('Lernkette: beide Generierungsrouten geben instructionsKey an den Lesezugriff weiter', () => {
  const src = fs.readFileSync(require.resolve('../routes/analyze'), 'utf8');
  const calls = src.match(/getFeedbackLearningsBlock\(resolvedClientId,[^;]*\)/g) || [];
  assert.ok(calls.length >= 2, 'Aufruf in POST / und /stream');
  for (const c of calls) assert.ok(c.includes('instructionsKey'), 'Schlüssel wird weitergegeben: ' + c);
  assert.equal((src.match(/const \{ module, clientId, data(, debug)?, instructionsKey, followUp \} = req\.body/g) || []).length, 2);
});

test('Lernkette Ende zu Ende: POST / und /stream legen Lernstand und Goldtext der Textart in den Auftrag', async () => {
  const a = await H.addClient('Kette C AG');
  const b = await H.addClient('Kette D AG');
  await H.pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary) VALUES ($1,'text-gen-email','TON','LERNSATZ-ALPHA-QQ.'),($1,'text-gen-linkedin','TON','LERNSATZ-FREMDE-ART-QQ.'),($2,'text-gen-email','TON','LERNSATZ-FREMDER-KLIENT-QQ.')`, [a.id, b.id]);
  await require('../lib/schemaRedesign').ensureSchema();
  await H.pool.query(`INSERT INTO goldtexte (client_id, feedback_key, text) VALUES ($1,'text-gen-email','GOLDTEXT-EIGEN-QQ'),($2,'text-gen-email','GOLDTEXT-FREMD-QQ')`, [a.id, b.id]);
  H.ai.calls.length = 0;
  H.ai.reply = 'Ein kurzer Text.';
  const body = { clientId: a.id, module: 'text-gen', instructionsKey: 'text-gen-email', data: { text: 'Einladung zum Anlass', tile: 'email' } };
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body });
  assert.equal(r.status, 200);
  const sys = H.ai.calls.map(systemText).join('\n');
  assert.ok(sys.includes('LERNSATZ-ALPHA-QQ'), 'Lernstand der Textart im Auftrag');
  assert.ok(!sys.includes('FREMDE-ART') && !sys.includes('FREMDER-KLIENT'));
  assert.ok(sys.includes('GOLDTEXT-EIGEN-QQ') && !sys.includes('GOLDTEXT-FREMD-QQ'));
  // ohne instructionsKey kein Lernstand der Textart
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { ...body, instructionsKey: undefined } });
  assert.ok(!H.ai.calls.map(systemText).join('\n').includes('LERNSATZ-ALPHA-QQ'));
});
