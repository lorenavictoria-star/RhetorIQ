// Regressionstest zur ganzen Lernkette: Lernstand je Textart speichern, beim Erzeugen lesen, Klienten trennen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const H = require('../test-support/harness');

let srv;
test.before(async () => {
  await H.setupBase();
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
  await H.pool.query(`CREATE TABLE IF NOT EXISTS client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
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
