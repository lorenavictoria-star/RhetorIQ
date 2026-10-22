const test = require('node:test');
const assert = require('node:assert');
const lint = require('../lib/lint');
const { stilmittelAusBrandVoice } = require('../lib/lintErlaubt');

const BV = 'Ton: direkt und warm.\nStilmittel erlaubt: Gegenüberstellungen, Dreierketten\nAnrede: Sie';

test('Nur was die Brand Voice unter «Stilmittel erlaubt» nennt, ist erlaubt', () => {
  const erlaubt = stilmittelAusBrandVoice(BV);
  assert.ok(erlaubt.has('gegenueberstellung'));
  assert.ok(!erlaubt.has('fuellwort'));
  const text = 'Wir sind nicht billig, sondern fair.';
  assert.ok(lint.lintText(text, { sprache: 'de' }).some(h => h.art === 'gegenueberstellung'));
  assert.equal(lint.lintText(text, { sprache: 'de', erlaubt }).filter(h => h.art === 'gegenueberstellung').length, 0);
});

test('Ohne Zeile in der Brand Voice bleibt alles streng', () => {
  assert.equal(stilmittelAusBrandVoice('Ton: direkt und warm.').size, 0);
});

test('Harte Regeln gelten immer, auch wenn Stilmittel erlaubt sind', () => {
  const erlaubt = stilmittelAusBrandVoice(BV);
  const hits = lint.lintText('Das ist gut \u2013 sehr gut. Stra\u00dfe.', { sprache: 'de', erlaubt });
  assert.ok(hits.some(h => h.art === 'gedankenstrich'));
  assert.ok(hits.some(h => h.art === 'eszett'));
});

test('Die Zeile wird auch mit Aufzählungszeichen oder Fettdruck erkannt, «keine» erlaubt nichts', () => {
  assert.ok(stilmittelAusBrandVoice('- **Stilmittel erlaubt:** Gegenüberstellungen').has('gegenueberstellung'));
  assert.equal(stilmittelAusBrandVoice('Stilmittel erlaubt: keine').size, 0);
});

test('Gegenüberstellungen in weiteren Formen werden erkannt, normale Verneinung nicht', () => {
  const ja = ['Das ist keine Zusatzleistung. Das ist, wie wir arbeiten.', 'Das ist kein Slogan - das beschreibt, was wir tun.', 'Kein Bruch. Ein sichtbares Bekenntnis.', 'Wir treffen uns persönlich, nicht per Mail.'];
  const nein = ['Wir haben keine Zeit für Umwege.', 'Ein Wechsel ist nicht möglich.', 'Sie erhalten keine Mahnung, wenn Sie rechtzeitig zahlen.'];
  for (const t of ja) assert.ok(lint.lintText(t, { sprache: 'de' }).some(h => h.art === 'gegenueberstellung'), t);
  for (const t of nein) assert.ok(!lint.lintText(t, { sprache: 'de' }).some(h => h.art === 'gegenueberstellung'), t);
});
