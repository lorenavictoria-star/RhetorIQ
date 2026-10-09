// Rangfolge-Block und gebündeltes Regelwerk (Aufgabe 1). Läuft ohne Datenbank.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/promptRules');
const { GLOBAL_STYLE_RULES } = require('../routes/analyze')._internal;

const count = (s, needle) => s.split(needle).length - 1;

test('Rangfolge-Block ist vorhanden, nur einmal und hat sechs Stufen', () => {
  assert.equal(GLOBAL_STYLE_RULES, R.GLOBAL_STYLE_RULES);
  assert.equal(count(GLOBAL_STYLE_RULES, 'RANGFOLGE (bei Widersprüchen'), 1);
  for (let i = 1; i <= 6; i++) assert.ok(R.RANGFOLGE_BLOCK.includes(`\n${i}. `), 'Stufe ' + i);
  assert.ok(/1\. Der aktuelle Auftrag/.test(R.RANGFOLGE_BLOCK));
  assert.ok(/6\. Die allgemeinen Stilregeln/.test(R.RANGFOLGE_BLOCK));
});

test('Regelwerk liegt unter 7000 Zeichen und die alten Vorrangsätze sind weg', () => {
  assert.ok(GLOBAL_STYLE_RULES.length < 7000, 'Länge ' + GLOBAL_STYLE_RULES.length);
  for (const alt of ['ABSOLUT VERBINDLICH', 'TAKES PRECEDENCE', 'ALWAYS OUTRANKS', 'override any conflicting']) {
    assert.ok(!GLOBAL_STYLE_RULES.includes(alt), alt);
    assert.ok(!R.BRAND_VOICE_HEAD.includes(alt), alt);
  }
});

test('Kernverbote und Schutz vor erfundenen Fakten bleiben im Regelwerk', () => {
  for (const muss of ['Gedankenstriche', '«ss»', '«ß»', 'Umlaute', 'Kein Markdown', 'Gendern mit Sonderzeichen', 'Floskel',
    'Erfinde nie', 'eckigen Klammern', 'nicht X, sondern Y', 'Formulierungen aus dem Gedächtnis', 'nie wörtlich']) {
    assert.ok(GLOBAL_STYLE_RULES.includes(muss), 'fehlt: ' + muss);
  }
});

test('Brand-Voice-Kopf ist für beide Pfade derselbe Baustein', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/analyze'), 'utf8');
  assert.equal(count(src, 'BRAND_VOICE_HEAD;'), 2);
  assert.ok(R.BRAND_VOICE_HEAD.includes('STIMME DES KLIENTEN'));
});
