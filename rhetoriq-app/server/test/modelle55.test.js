// Modelle der Generation 5.5: keine Sampling-Parameter, Aufwand niedrig, Textblöcke statt erster Block, Preise im Nutzungsprotokoll.
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../lib/aiProvider');
const meter = require('../lib/meter');

const basis = { system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 500, temperature: 0.7 };

test('Sonnet 5.5: ohne temperature, Aufwand low, Denken nur zwischen Werkzeugen (nie «disabled»)', () => {
  const b = ai.buildBody({ ...basis, model: 'claude-sonnet-5-5' }, false);
  assert.equal(b.temperature, undefined);
  assert.deepEqual(b.thinking, { type: 'between_tools' });
  assert.deepEqual(b.output_config, { effort: 'low' });
  assert.equal(b.max_tokens, 500);
  process.env.EFFORT_SONNET = 'medium';
  assert.deepEqual(ai.buildBody({ ...basis, model: 'claude-sonnet-5-5' }, true).output_config, { effort: 'medium' });
  process.env.EFFORT_SONNET = 'xhigh';   // mit between_tools nicht erlaubt: fällt auf low zurück
  assert.deepEqual(ai.buildBody({ ...basis, model: 'claude-sonnet-5-5' }, true).output_config, { effort: 'low' });
  delete process.env.EFFORT_SONNET;
});

test('Haiku 5.5: ohne temperature, Aufwand low, adaptives Denken bleibt (kein thinking-Feld)', () => {
  const b = ai.buildBody({ ...basis, model: 'claude-haiku-5-5' }, false);
  assert.equal(b.temperature, undefined);
  assert.equal(b.thinking, undefined);
  assert.deepEqual(b.output_config, { effort: 'low' });
});

test('Ältere Modelle bleiben unverändert (temperature bleibt, keine neuen Felder)', () => {
  for (const m of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
    const b = ai.buildBody({ ...basis, model: m }, false);
    assert.equal(b.temperature, 0.7); assert.equal(b.thinking, undefined); assert.equal(b.output_config, undefined);
  }
});

test('Antworttext: Textblöcke zusammensetzen, ein vorangehender Denkblock stört nicht', () => {
  assert.equal(ai.textAus([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Guten Tag' }]), 'Guten Tag');
  assert.equal(ai.textAus([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), 'AB');
  assert.equal(ai.textAus(undefined), '');
});

test('Preise: Sonnet 5.5 und Haiku 5.5 werden richtig berechnet, auch mit Reserve-Vorsatz', () => {
  assert.equal(meter.costUsd({ model: 'claude-sonnet-5-5', inputTokens: 1e6 }), 2);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-5-5', outputTokens: 1e6 }), 10);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-5-5', cacheReadTokens: 1e6 }), 0.1);
  assert.equal(meter.costUsd({ model: 'claude-haiku-5-5', inputTokens: 1e6 }), 0.1);
  assert.equal(meter.costUsd({ model: 'reserve:claude-haiku-5-5', outputTokens: 1e6 }), 0.5);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', inputTokens: 1e6 }), 3);
  assert.equal(meter.costUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 1e6 }), 1);
});
