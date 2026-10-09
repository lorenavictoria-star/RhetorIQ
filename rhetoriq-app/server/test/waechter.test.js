// KI-Wächter und Statusendpunkt: Attrappen für KI und Mail, keine echten Aufrufe.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { runWaechter } = require('../jobs/ki-waechter');
const { getStatus } = require('../lib/systemStatus');

let srv;
test.before(async () => {
  await H.setupBase();
  await H.pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  srv = await H.startApp([['/api/status', require('../routes/status')]]);
});
test.after(async () => { await srv.close(); });

// Uhr der Tests: jeder Lauf 5 Minuten nach dem vorigen
const MIN = 60 * 1000;
let t = Date.now();
let cheapCalls = 0, cheapFail = false;
const cheap = async () => { cheapCalls++; if (cheapFail) throw Object.assign(new Error('Schnittstelle nicht erreichbar'), { status: 503 }); return { input_tokens: 8 }; };
const W = (o = {}) => runWaechter({ cheap, status: async () => 'minor: Elevated errors', now: (t += 5 * MIN), ...o });

test('Erster Lauf macht den echten Aufruf (1 Ausgabe-Token, haiku, Modul waechter), danach nur der kostenlose Prüfaufruf', async () => {
  H.ai.fail = false; H.ai.calls.length = 0; H.ai.reply = 'ok'; cheapCalls = 0;
  const r = await W();
  assert.equal(r.ok, true);
  assert.equal(r.gen, true);
  const c = H.ai.calls[0];
  assert.equal(c.maxTokens, 1);
  assert.equal(c.meter.module, 'waechter');
  assert.match(c.model, /haiku/);
  // fünf weitere Läufe in den nächsten 25 Minuten: kein Erzeugungsaufruf
  for (let i = 0; i < 5; i++) { const x = await W(); assert.equal(x.gen, false); }
  assert.equal(H.ai.calls.length, 1, 'in 25 Minuten nur der erste echte Aufruf');
  assert.equal(cheapCalls, 6, 'der Prüfaufruf läuft bei jedem Lauf');
  // nach 30 Minuten wieder ein echter Aufruf
  const y = await W();
  assert.equal(y.gen, true);
  assert.equal(H.ai.calls.length, 2);
});

test('Prüfaufruf schlägt fehl: Fehler zählt sofort, ohne echten Aufruf; drei Fehler lösen eine Mail pro Störung aus, mit Statusseite', async () => {
  H.mails.length = 0; H.ai.calls.length = 0; cheapFail = true;
  await W(); await W();
  assert.equal(H.mails.length, 0);
  assert.equal((await srv.call('GET', '/api/status')).body.ki, 'ok');
  const r3 = await W();
  assert.equal(r3.stoerung, true);
  assert.equal(H.mails.length, 1);
  assert.match(H.mails[0].subject, /gestört/);
  assert.match(H.mails[0].text, /Prüfaufruf: Schnittstelle nicht erreichbar/);
  assert.match(H.mails[0].text, /Statusseite von Anthropic: minor/);
  assert.equal(H.ai.calls.length, 0, 'bei Fehler des Prüfaufrufs kein Erzeugungsaufruf nötig');
  await W(); await W();
  assert.equal(H.mails.length, 1, 'keine zweite Mail bei derselben Störung');
  assert.equal(await getStatus('ki_stoerung'), true);
  const s = await srv.call('GET', '/api/status');
  assert.deepEqual(s.body, { ki: 'gestoert' }, 'ohne Details');
});

test('Während der Störung laufen beide Prüfungen in jedem Lauf; Wiederkehr entwarnt per Mail und löscht den Hinweis', async () => {
  cheapFail = false; H.ai.fail = true; H.ai.calls.length = 0;
  const r = await W();
  assert.equal(r.ok, false, 'Erzeugung schlägt fehl, obwohl der Prüfaufruf geht (Modell überlastet)');
  assert.equal(H.ai.calls.length, 1, 'bei laufender Störung wird der echte Aufruf nicht abgewartet');
  H.ai.fail = false;
  const e = await W();
  assert.equal(e.entwarnung, true);
  assert.equal(H.ai.calls.length, 2);
  assert.equal(H.mails.length, 2);
  assert.match(H.mails[1].subject, /Entwarnung/);
  assert.deepEqual((await srv.call('GET', '/api/status')).body, { ki: 'ok' });
});

test('Erzeugung fällt zwischen zwei echten Aufrufen aus: wird spätestens beim nächsten echten Aufruf erkannt, nicht vom Prüfaufruf', async () => {
  H.ai.calls.length = 0;
  for (let i = 0; i < 4; i++) await W();       // Prüfaufrufe, Erzeugung ist nicht fällig
  H.ai.fail = true;
  const still = await W();
  assert.equal(still.ok, true, 'Prüfaufruf allein sieht nichts');
  assert.equal(H.ai.calls.length, 0);
  const bad = await W();                        // nach 30 Minuten fällig: jetzt sichtbar
  assert.equal(bad.ok, false);
  assert.equal(bad.fails, 1);
  H.ai.fail = false;
});

test('Tagesbudget: ist die Grenze erreicht, entfällt der echte Aufruf und Lorena wird einmal informiert', async () => {
  H.ai.calls.length = 0; H.brevoMails.length = 0;
  await W();                                    // Zustand mit offener Störung bereinigen
  await W(); await W();
  process.env.BUDGET_WAECHTER_USD = '0.01';
  try {
    await H.pool.query(`INSERT INTO usage_log (module, model, input_tokens, output_tokens, cost_usd) VALUES ('waechter','claude-haiku-4-5-20251001',1,1,0.05)`);
    H.ai.calls.length = 0;
    await W(); await W();
    t += 40 * MIN;
    const r = await W();
    assert.equal(r.ok, true);
    assert.equal(H.ai.calls.length, 0, 'kein echter Aufruf bei erreichtem Budget');
    assert.equal(H.brevoMails.filter(m => /Tagesbudget/.test(m.subject)).length, 1, 'eine Mail pro Funktion und Tag');
  } finally { delete process.env.BUDGET_WAECHTER_USD; await H.pool.query('DELETE FROM usage_log'); }
});

test('Prüfaufruf: count_tokens ohne Erzeugung, Schlüssel im Kopf; Statusseite wirft nie', async () => {
  const { cheapCheck, statusSeite } = require('../jobs/ki-waechter');
  const real = global.fetch;
  const seen = [];
  process.env.ANTHROPIC_API_KEY = 'sk-test-attrappe';
  try {
    global.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      if (String(url).includes('status.anthropic.com')) return { ok: true, json: async () => ({ status: { indicator: 'none', description: 'All Systems Operational' } }) };
      return { ok: true, status: 200, json: async () => ({ input_tokens: 9 }) };
    };
    const r = await cheapCheck();
    assert.equal(r.input_tokens, 9);
    assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages/count_tokens');
    assert.equal(seen[0].init.headers['x-api-key'], 'sk-test-attrappe');
    assert.ok(!('max_tokens' in JSON.parse(seen[0].init.body)), 'es wird nichts erzeugt');
    assert.match(await statusSeite(), /^none: All Systems/);
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
    await assert.rejects(cheapCheck(), /invalid x-api-key/);
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal(await statusSeite(), null);
  } finally { global.fetch = real; delete process.env.ANTHROPIC_API_KEY; }
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
