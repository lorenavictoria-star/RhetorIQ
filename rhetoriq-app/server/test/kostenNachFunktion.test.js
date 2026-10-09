// Kosten je Funktion: Endpunkt GET /api/advisor/costs-by-module und die Zeile im Wochenbericht.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = require('../db');
const meter = require('../lib/meter');
const { kostenNachFunktion, zeileTeuersteFunktionen } = require('../lib/kostenNachFunktion');

let srv, mine, fremd;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO users (email, name) VALUES ('zweite@test.ch', 'Zweite Beraterin')`);
  mine = await H.addClient('Kosten AG');
  const f = await H.addClient('Fremd AG');
  await pool.query('UPDATE clients SET advisor_id=2 WHERE id=$1', [f.id]);
  fremd = f;
  srv = await H.startApp([['/api/advisor', require('../routes/advisor')]]);
});
test.after(async () => { await srv.close(); });

const S = 'claude-sonnet-4-6', HK = 'claude-haiku-4-5-20251001';
async function zeile(module, model, u, { advisorId = 1, clientId = mine.id, tageAlt = 0 } = {}) {
  const cost = meter.costUsd({ model, ...u });
  await pool.query(
    `INSERT INTO usage_log (advisor_id, client_id, module, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() - ($10 || ' days')::interval)`,
    [advisorId, clientId, module, model, u.inputTokens || 0, u.outputTokens || 0, u.cacheCreationTokens || 0, u.cacheReadTokens || 0, cost, tageAlt]);
  return cost;
}

test('Kosten je Funktion: gruppiert, Anteil, Zwischenspeicher-Lesequote, Hinweis «läuft ohne Klick»', async () => {
  await zeile('text-gen', S, { cacheCreationTokens: 6000, outputTokens: 600 });
  await zeile('text-gen', S, { cacheReadTokens: 6000, inputTokens: 800, outputTokens: 600 });
  await zeile('lernen-korrektur', HK, { inputTokens: 1700, outputTokens: 200 });
  await zeile('lernen-korrektur', HK, { inputTokens: 1700, outputTokens: 200 });
  await zeile('sparring', S, { inputTokens: 3000, outputTokens: 1000 });
  await zeile('ki', HK, { inputTokens: 100, outputTokens: 10 });
  await zeile('text-gen', S, { inputTokens: 999999 }, { tageAlt: 60 });          // ausserhalb von 30 Tagen
  await zeile('text-gen', S, { inputTokens: 999999 }, { advisorId: 2, clientId: fremd.id });   // andere Beraterin
  const r = await srv.call('GET', '/api/advisor/costs-by-module?days=30', { token: H.advisorToken() });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.rows.map(x => [x.module, x]));
  assert.deepEqual(Object.keys(by).sort(), ['ki', 'lernen-korrektur', 'sparring', 'text-gen']);
  const tg = by['text-gen'];
  assert.equal(tg.calls, 2);
  assert.equal(tg.cache_read_tokens, 6000);
  assert.equal(tg.cache_creation_tokens, 6000);
  assert.equal(tg.cache_read_share, 50);
  assert.equal(tg.automatisch, false);
  assert.deepEqual(tg.models, ['Sonnet']);
  const erwartet = meter.costUsd({ model: S, cacheCreationTokens: 6000, outputTokens: 600 }) + meter.costUsd({ model: S, cacheReadTokens: 6000, inputTokens: 800, outputTokens: 600 });
  assert.ok(Math.abs(tg.cost_usd - erwartet) < 1e-5);
  assert.ok(Math.abs(tg.cost_per_call - erwartet / 2) < 1e-5);
  const lk = by['lernen-korrektur'];
  assert.equal(lk.automatisch, true);
  assert.equal(lk.ausloeser, 'Hintergrundaufruf nach einem Ereignis');
  assert.deepEqual(lk.models, ['Haiku']);
  assert.equal(lk.cache_read_share, null);
  assert.match(by['sparring'].label, /^Rhetoric Sparring: Micro-Coaching$/, 'Name aus dem Modulkatalog, ohne Gedankenstrich');
  assert.match(by['ki'].label, /Nicht zugeordnet/);
  // Summe und Anteile
  const summe = r.body.rows.reduce((s, x) => s + x.cost_usd, 0);
  assert.ok(Math.abs(summe - r.body.total_usd) < 1e-5);
  assert.ok(Math.abs(r.body.rows.reduce((s, x) => s + x.share, 0) - 100) < 0.5);
  assert.ok(Math.abs(r.body.auto_usd - lk.cost_usd) < 1e-5);
  // absteigend nach Kosten
  for (let i = 1; i < r.body.rows.length; i++) assert.ok(r.body.rows[i - 1].cost_usd >= r.body.rows[i].cost_usd);
  assert.equal(r.body.top3.length, 3);
  assert.equal(r.body.top3[0].module, r.body.rows[0].module);
});

test('Zugriff: nur Beraterin, Tage geprüft, Zeilen ohne Beraterin nur für die Betreiberin', async () => {
  assert.equal((await srv.call('GET', '/api/advisor/costs-by-module', { token: H.clientToken(mine.id) })).status, 403);
  assert.equal((await srv.call('GET', '/api/advisor/costs-by-module')).status, 401);
  assert.equal((await srv.call('GET', '/api/advisor/costs-by-module?days=9999', { token: H.advisorToken() })).status, 400);
  await zeile('waechter', HK, { inputTokens: 25, outputTokens: 1 }, { advisorId: null, clientId: null });
  await zeile('schnelltest', HK, { inputTokens: 2000, outputTokens: 250 }, { advisorId: null, clientId: null });
  const betreiberin = await srv.call('GET', '/api/advisor/costs-by-module', { token: H.advisorToken() });
  const keys = betreiberin.body.rows.map(x => x.module);
  assert.ok(keys.includes('waechter') && keys.includes('schnelltest'));
  assert.equal(betreiberin.body.rows.find(x => x.module === 'waechter').automatisch, true);
  assert.equal(betreiberin.body.rows.find(x => x.module === 'schnelltest').ausloeser, 'Besucherin ohne Login');
  const zweite = await srv.call('GET', '/api/advisor/costs-by-module', { token: H.advisorToken({ id: 2 }) });
  assert.equal(zweite.status, 200);
  const k2 = zweite.body.rows.map(x => x.module);
  assert.ok(!k2.includes('waechter') && !k2.includes('lernen-korrektur'), 'keine Plattform- und keine fremden Zeilen');
  assert.deepEqual(k2, ['text-gen'], 'nur die eigenen Zeilen der zweiten Beraterin');
});

test('Wochenbericht: eine Zeile mit den drei teuersten Funktionen', async () => {
  const d = await kostenNachFunktion({ days: 7 });
  const z = zeileTeuersteFunktionen(d);
  assert.match(z, /^  Teuerste Funktionen: /);
  assert.equal(z.split('; ').length, 3);
  assert.match(z, /läuft ohne Klick/);
  assert.doesNotMatch(z, /[–—]/);
  assert.equal(zeileTeuersteFunktionen({ top3: [] }), null);
});
