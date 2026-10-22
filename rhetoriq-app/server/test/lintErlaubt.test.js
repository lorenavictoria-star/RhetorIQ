const test = require('node:test');
const assert = require('node:assert');
const lint = require('../lib/lint');
const { musterAusTexten } = require('../lib/lintErlaubt');

const GEGENUEBER = 'Das ist nicht laut, sondern klar. Wir arbeiten nicht schnell, sondern gründlich.';

test('Weiche Muster, die in den Kundentexten vorkommen, sind für diesen Kunden erlaubt', () => {
  const erlaubt = musterAusTexten([GEGENUEBER]);
  assert.ok(erlaubt.has('gegenueberstellung'));
  const text = 'Wir sind nicht billig, sondern fair.';
  assert.ok(lint.lintText(text, { sprache: 'de' }).some(h => h.art === 'gegenueberstellung'));
  assert.equal(lint.lintText(text, { sprache: 'de', erlaubt }).filter(h => h.art === 'gegenueberstellung').length, 0);
});

test('Ein einziges Vorkommen genügt nicht, Muster bleibt Hinweis', () => {
  assert.equal(musterAusTexten(['Das ist nicht laut, sondern klar.']).size, 0);
});

test('Harte Regeln gelten immer, auch wenn weiche Muster erlaubt sind', () => {
  const erlaubt = musterAusTexten([GEGENUEBER]);
  const hits = lint.lintText('Das ist gut – sehr gut. Straße.', { sprache: 'de', erlaubt });
  assert.ok(hits.some(h => h.art === 'gedankenstrich'));
  assert.ok(hits.some(h => h.art === 'eszett'));
});
