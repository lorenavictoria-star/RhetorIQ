// Temperatur und Modellwahl (Aufgabe 5). Die Wirkung der Werte ist nicht gemessen, geprüft wird nur die Verdrahtung.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const T = require('../lib/temperaturen');
const { HAIKU_MODULES } = require('../routes/analyze')._internal;

test('Tabelle: 0.7 für Textarten, 0.2 für Analyse- und Prüfmodule, sonst keine Angabe', () => {
  assert.deepEqual(T.TEMPERATUR, { text: 0.7, analyse: 0.2 });
  for (const m of ['text-gen', 'before-after', 'rh-translate', 'presentation', 'ghostwriter']) assert.equal(T.temperaturFor(m), 0.7, m);
  for (const m of ['rm', 'la', 'as', 'rp', 'cf', 'health-score']) assert.equal(T.temperaturFor(m), 0.2, m);
  for (const m of ['router', 'brand-voice-co', 'consolidate-feedback', 'unbekannt']) assert.equal(T.temperaturFor(m), undefined, m);
});

test('Modellwahl: Übersetzen und Vorher/Nachher auf Sonnet, Routing, Betreff und Titel bleiben Haiku', () => {
  assert.ok(!HAIKU_MODULES.has('before-after'));
  assert.ok(!HAIKU_MODULES.has('rh-translate'));
  for (const m of ['router', 'route-fill', 'suggest-subject', 'suggest-title']) assert.ok(HAIKU_MODULES.has(m), m);
});

test('Onboarding-Dateisortierung nutzt Haiku über den Adapter', () => {
  const src = fs.readFileSync(require.resolve('../routes/onboard'), 'utf8');
  assert.ok(src.includes("resolveModelId('haiku')"));
  assert.ok(!src.includes("resolveModelId('sonnet')"));
});

let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

async function lauf(module, data) {
  H.ai.calls.length = 0;
  H.ai.reply = 'Ein kurzer Text.';
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module, data } });
  H.ai.reply = '{}';
  assert.equal(r.status, 200);
  return H.ai.calls.slice();
}

test('POST /: Text Generator läuft mit 0.7 in beiden Durchgängen, Risk Management mit 0.2', async () => {
  const tg = await lauf('text-gen', { text: 'Mail an Kundschaft' });
  assert.equal(tg.length, 2);
  for (const c of tg) assert.equal(c.temperature, 0.7);
  const rm = await lauf('rm', { text: 'Wir schreiben an die Presse.' });
  assert.equal(rm.length, 1);
  assert.equal(rm[0].temperature, 0.2);
});

test('POST /: Vorher/Nachher und Übersetzen verwenden das Sonnet-Modell, Betreff das Haiku-Modell', async () => {
  const ba = await lauf('before-after', { text: 'Alter Text' });
  assert.equal(ba[0].model, 'test-sonnet');
  const rt = await lauf('rh-translate', { text: 'Text', targetLanguage: 'English' });
  assert.equal(rt[0].model, 'test-sonnet');
  H.ai.calls.length = 0;
  H.ai.reply = 'Betreff';
  const r = await srv.call('POST', '/api/analyze/suggest-subject', { token: H.advisorToken(), body: { text: 'Mail an die Kundschaft wegen der Preise' } });
  H.ai.reply = '{}';
  assert.equal(r.status, 200);
  assert.equal(H.ai.calls[0].model, 'test-haiku');
});
