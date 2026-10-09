// Adapter: Wiederholung, Reservekonto, Schalter, Modellnamen. Fetch-Attrappe, keine echten Aufrufe.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
const recorded = [];
const ctx = {};
stub('lib/meter.js', { record: async (e) => { recorded.push(e); }, context: () => ctx });
let forced = false;
stub('lib/systemStatus.js', { getStatus: async () => (forced ? { an: true } : null), setStatus: async () => {} });

process.env.ANTHROPIC_API_KEY = 'haupt-key';
delete process.env.ANTHROPIC_API_KEY_2;
const ai = require('../lib/aiProvider');
ai._cfg.waits = [0, 0];

const realFetch = global.fetch;
const log = [];
let script = [];
global.fetch = async (url, opts) => {
  const step = script.shift();
  log.push({ url, key: opts.headers['x-api-key'], body: JSON.parse(opts.body) });
  if (!step) throw new Error('Unerwarteter Aufruf');
  if (step.throw) throw step.throw;
  const body = step.sse
    ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(step.sse)); c.close(); } })
    : null;
  return {
    ok: step.status === 200, status: step.status,
    json: async () => step.json,
    body
  };
};
const okJson = (t) => ({ status: 200, json: { content: [{ text: t }], usage: { input_tokens: 3, output_tokens: 2 } } });
const err = (status, message) => ({ status, json: { error: { message } } });
const reset = () => { log.length = 0; recorded.length = 0; delete ctx.reserve; forced = false; ai.resetReserveCache(); delete process.env.ANTHROPIC_API_KEY_2; };
const ask = (extra = {}) => ai.generateText({ system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 5, model: 'claude-haiku-4-5-20251001', ...extra });

test.after(() => { global.fetch = realFetch; });

test('Modellnamen sind Einstellungen mit heutigen Standardwerten', () => {
  delete process.env.MODEL_SONNET; delete process.env.MODEL_HAIKU;
  assert.equal(ai.resolveModelId('sonnet'), 'claude-sonnet-4-6');
  assert.equal(ai.resolveModelId('haiku'), 'claude-haiku-4-5-20251001');
  process.env.MODEL_SONNET = 'neues-modell';
  assert.equal(ai.resolveModelId('sonnet'), 'neues-modell');
  delete process.env.MODEL_SONNET;
});

test('Überlastung 529: zwei Wiederholungen, dann Erfolg', async () => {
  reset();
  script = [err(529, 'Overloaded'), err(503, 'busy'), okJson('hallo')];
  const r = await ask();
  assert.equal(r.text, 'hallo');
  assert.equal(log.length, 3);
  assert.equal(r.reserve, undefined);
});

test('Ohne Reservekonto: nach drei Fehlschlägen kommt der Fehler an', async () => {
  reset();
  script = [err(500, 'x'), err(500, 'x'), err(500, 'y')];
  await assert.rejects(ask(), /y/);
  assert.equal(log.length, 3);
});

test('Anfragefehler 400 wird nicht wiederholt', async () => {
  reset();
  script = [err(400, 'bad request')];
  await assert.rejects(ask(), /bad request/);
  assert.equal(log.length, 1);
});

test('Kontofehler 402: sofort auf den zweiten Schlüssel, Vermerk im Protokoll', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  script = [err(402, 'Your credit balance is too low'), okJson('mit reserve')];
  const r = await ask({ meter: { module: 'test' } });
  assert.equal(r.text, 'mit reserve');
  assert.equal(r.reserve, true);
  assert.equal(log.length, 2);
  assert.equal(log[0].key, 'haupt-key');
  assert.equal(log[1].key, 'reserve-key');
  assert.equal(recorded[0].model, 'reserve:claude-haiku-4-5-20251001');
  assert.equal(ctx.reserve, true);
});

test('Meldung zu Guthaben bei Status 400 gilt als Kontofehler', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  script = [err(400, 'Your credit balance is too low to access the API'), okJson('ok')];
  assert.equal((await ask()).reserve, true);
});

test('Wiederholungen erschöpft: Reservekonto springt ein', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  script = [err(529, 'o'), err(529, 'o'), err(529, 'o'), okJson('reserve ok')];
  const r = await ask();
  assert.equal(r.reserve, true);
  assert.deepEqual(log.map(l => l.key), ['haupt-key', 'haupt-key', 'haupt-key', 'reserve-key']);
});

test('Schalter ai_reserve_erzwingen nutzt nur das Reservekonto', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  forced = true;
  script = [okJson('direkt reserve')];
  const r = await ask();
  assert.equal(r.reserve, true);
  assert.deepEqual(log.map(l => l.key), ['reserve-key']);
});

test('Normalfall ohne Reservekonto bleibt unverändert (ein Aufruf, normaler Modellname)', async () => {
  reset();
  script = [okJson('normal')];
  const r = await ask({ meter: { module: 'x' } });
  assert.equal(r.text, 'normal');
  assert.equal(log.length, 1);
  assert.equal(recorded[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(log[0].body.system[0].text, 'S');
});

test('Anfrage ohne system wird ohne system gesendet', async () => {
  reset();
  script = [okJson('a')];
  await ai.generateText({ messages: [{ role: 'user', content: 'x' }], maxTokens: 5, model: 'm' });
  assert.equal('system' in log[0].body, false);
});

const sse = (t) => 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }) + '\n\n';
async function collect(opts) { let t = ''; for await (const e of ai.streamText(opts)) if (e.type === 'text') t += e.text; return t; }

test('Stream: Wiederholung vor dem ersten Token, dann Reservekonto', async () => {
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  script = [err(503, 'x'), { status: 200, sse: sse('Hallo ') + sse('Welt') }];
  const t = await collect({ system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, model: 'claude-sonnet-4-6' });
  assert.equal(t, 'Hallo Welt');
  assert.equal(log.length, 2);
  assert.equal(log[1].key, 'haupt-key');
  assert.equal(ctx.reserve, undefined);
  reset();
  process.env.ANTHROPIC_API_KEY_2 = 'reserve-key';
  script = [err(401, 'invalid x-api-key'), { status: 200, sse: sse('R') }];
  const t2 = await collect({ system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, model: 'claude-sonnet-4-6' });
  assert.equal(t2, 'R');
  assert.equal(ctx.reserve, true);
  assert.equal(recorded[recorded.length - 1].model, 'reserve:claude-sonnet-4-6');
});
