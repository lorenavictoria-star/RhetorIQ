// Kostenzählung: exakte Preise je Modell, Zwischenspeicher, Zuordnung zum Klienten.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const meter = require('../lib/meter');
const { pool } = require('../db');

test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
});

test('Preise: Sonnet, Haiku, Zwischenspeicher, unbekanntes Modell wie Sonnet', () => {
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', inputTokens: 1e6 }), 3);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', outputTokens: 1e6 }), 15);
  assert.equal(meter.costUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 1e6, outputTokens: 1e6 }), 6);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', cacheCreationTokens: 1e6 }), 3.75);
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', cacheReadTokens: 1e6 }), 0.3);
  assert.equal(meter.costUsd({ model: 'irgendwas', inputTokens: 1e6 }), 3);
  // Beispiel: ein zweistufiger Text mit grossem Gedächtnis
  assert.equal(meter.costUsd({ model: 'claude-sonnet-4-6', inputTokens: 3000, outputTokens: 1500, cacheCreationTokens: 8000, cacheReadTokens: 20000 }), 0.0675);
});

test('record schreibt Tokens, Zwischenspeicher, Modell und Kosten; Zuordnung aus dem Zugriff', async () => {
  const c = await H.addClient('Meter AG');
  await meter.run({ advisorId: 1, clientId: c.id, module: 'text-gen' }, async () => {
    await meter.record({ model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 2000, cacheReadTokens: 10000 });
  });
  const { rows } = await pool.query('SELECT * FROM usage_log WHERE client_id=$1', [c.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].module, 'text-gen');
  assert.equal(Number(rows[0].cache_read_tokens), 10000);
  assert.equal(Number(rows[0].cost_usd), meter.costUsd({ model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 2000, cacheReadTokens: 10000 }));
});

test('opts.meter überschreibt den Zugriff, leere Aufrufe werden nicht protokolliert', async () => {
  const c = await H.addClient('Meter2 AG');
  await meter.record({ model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 50, meter: { clientId: c.id, advisorId: 1, module: 'learn' } });
  assert.equal(await meter.record({ model: 'x' }), null);
  const { rows } = await pool.query('SELECT module, model FROM usage_log WHERE client_id=$1', [c.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'claude-haiku-4-5-20251001');
});

test('recordApi übernimmt das usage-Objekt der Anthropic-Antwort', async () => {
  const c = await H.addClient('Meter3 AG');
  await meter.recordApi('claude-sonnet-4-6', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }, { clientId: c.id, advisorId: 1, module: 'onboard' });
  const { rows } = await pool.query('SELECT cache_read_tokens, cost_usd FROM usage_log WHERE client_id=$1', [c.id]);
  assert.equal(Number(rows[0].cache_read_tokens), 1000);
  assert.ok(Number(rows[0].cost_usd) > 0);
});

test('Abopreis je Kontingent für die Monatswarnung', () => {
  const { planPriceChf } = require('../lib/costAlerts');
  assert.equal(planPriceChf(300000), 290);
  assert.equal(planPriceChf(1500000), 990);
  assert.equal(planPriceChf(null), 2490);
  assert.equal(planPriceChf(12345), null);
});
