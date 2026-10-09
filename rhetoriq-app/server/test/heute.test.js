// Heutiges Datum im Auftrag (Aufgabe 2): Funktion mit festgelegter Uhr, beide Routen.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate, systemText } = require('../test-support/genSetup');
const { heuteZeile } = require('../lib/heute');

test('heuteZeile: Wochentag, Datum und Zeitzone mit festgelegter Uhr', () => {
  assert.equal(heuteZeile(new Date('2026-10-09T10:00:00Z')),
    'Heute ist Freitag, 9. Oktober 2026 (Zeitzone Europe/Zurich). Relative Datumsangaben (morgen, nächsten Freitag) aus diesem Datum berechnen.');
  // 23:30 UTC am 31.12. ist in Zürich bereits der 1. Januar
  assert.ok(heuteZeile(new Date('2026-12-31T23:30:00Z')).startsWith('Heute ist Freitag, 1. Januar 2027'));
  // Sommerzeit: 22:30 UTC am 30.6. ist in Zürich schon der 1.7.
  assert.ok(heuteZeile(new Date('2026-06-30T22:30:00Z')).startsWith('Heute ist Mittwoch, 1. Juli 2026'));
});

let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

test('Datum steht im ungecachten Teil des Auftrags, in POST / und /stream', async () => {
  H.ai.calls.length = 0;
  H.ai.reply = 'Ein kurzer Text.';
  const body = { module: 'text-gen', data: { text: 'Einladung zum Anlass', tile: 'email' } };
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body });
  assert.equal(r.status, 200);
  assert.ok(H.ai.calls.length >= 1);
  for (const c of H.ai.calls) {
    const blocks = c.system;
    const idx = blocks.findIndex(b => b.text.includes('Heute ist '));
    assert.ok(idx > 0, 'Datum vorhanden und nicht im ersten (gecachten) Basisblock');
    assert.ok(!blocks[idx].cache_control, 'Datumsblock selbst ohne Markierung');
    assert.ok(!blocks[0].text.includes('Heute ist '));
    assert.ok(systemText(c).includes('Relative Datumsangaben (morgen, nächsten Freitag)'));
  }
  // Stream-Pfad: Quelltext enthält denselben Aufruf vor dem Aufbau der Systemblöcke
  const src = require('fs').readFileSync(require.resolve('../routes/analyze'), 'utf8');
  assert.equal((src.match(/restDynamicSystem \+= heuteBlock\(\)/g) || []).length, 2);
});
