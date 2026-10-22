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

test('«euch» und «eure» zählen als Du-Form', () => {
  const hits = lint.lintText('Das ist planbar auf eurer Seite, wir tragen es für euch.', { sprache: 'de', anrede: 'sie' });
  assert.equal(hits.filter(h => h.art === 'anrede').length, 2);
});

test('Gelernte Sätze werden nicht an Abkürzungen wie «z. B.» getrennt', () => {
  const { sentences } = require('../lib/learnedMeta');
  const s = sentences('Konkrete Leistungen (z. B. Biopropan) müssen genannt werden. Das bedeutet, d. h. ohne Floskeln, klare Aussagen. Letzter Satz.');
  assert.equal(s.length, 3);
  assert.ok(s[0].includes('z. B. Biopropan'));
});

test('Kurzer Strich nur in Titeln und zwischen Zahlen, langer Strich nie', () => {
  const t = 'Neues Logo – neue Energie\n\nWir liefern 10–12 Tonnen. Das gilt – auch morgen. Er sagte — ja.';
  const d = lint.lintText(t, { sprache: 'de' }).filter(h => h.art === 'gedankenstrich');
  assert.equal(d.length, 2);   // der kurze Strich im Fliesstext und der lange Strich
});

test('Gegenüberstellungen: Rede darf drei, Mail keine, Behauptungen brauchen einen Beleg', () => {
  const g = 'Das ist kein Slogan. Das ist Haltung. Das ist kein Kompromiss. Das ist Entscheidung.';
  assert.equal(lint.lintText(g, { sprache: 'de', textart: 'speech' }).filter(h => h.art === 'gegenueberstellung').length, 0);
  assert.ok(lint.lintText(g, { sprache: 'de', textart: 'email' }).some(h => h.art === 'gegenueberstellung'));
  const b = 'Wir sind die Compositeflasche als erste in der Schweiz und einziger Anbieter.';
  assert.ok(lint.lintText(b, { sprache: 'de' }).filter(h => h.art === 'alleinstellung').length >= 1);
  assert.equal(lint.lintText(b, { sprache: 'de', belege: 'Wir sind als erste in der Schweiz mit einziger Anbieter' }).filter(h => h.art === 'alleinstellung').length, 0);
});
