// Faktenmarker (Aufgabe 4): markiert nur, was nicht im Auftrag steht. Baut auf public/pruefhinweise.js auf.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../public/faktenmarker.js');

const markiert = (r) => r.segmente.filter(s => s.fakt).map(s => s.text);

test('Zahlen, Prozente, Beträge, Daten und Namen aus dem Auftrag bleiben unmarkiert', () => {
  const briefing = 'Preise steigen am 12. März 2027 um 3 % auf CHF 1\'200. Kontakt Anna Keller.';
  const text = 'Guten Tag Anna Keller, am 12. März 2027 steigen die Preise um 3 % auf CHF 1\'200.';
  const r = F.markiere(text, briefing);
  assert.deepEqual(markiert(r), []);
  assert.equal(r.anzahl, 0);
});

test('Was nicht im Auftrag steht, wird markiert (Zahl, Prozent, Betrag, Datum, Name)', () => {
  const briefing = 'Wir erhöhen die Preise.';
  const text = 'Wir erhöhen die Preise um 7 % per 1. April 2027, das sind CHF 450 pro Monat, sagt Hans Meier.';
  const r = F.markiere(text, briefing);
  const m = markiert(r);
  for (const erwartet of ['7 %', '1. April 2027', 'CHF 450', 'Hans Meier']) assert.ok(m.includes(erwartet), erwartet + ' in ' + JSON.stringify(m));
  assert.equal(r.anzahl, m.length);
  // Der Text bleibt beim Zusammensetzen unverändert
  assert.equal(r.segmente.map(s => s.text).join(''), text);
});

test('Tausenderschreibweise: 1\'200 im Ergebnis entspricht 1200 im Auftrag', () => {
  const r = F.markiere('Das kostet CHF 1\'200 im Jahr.', 'Preis 1200 Franken');
  assert.deepEqual(markiert(r), []);
  const r2 = F.markiere('Das kostet CHF 1\'300 im Jahr.', 'Preis 1200 Franken');
  assert.deepEqual(markiert(r2), ['CHF 1\'300']);
});

test('HTML: Fundstellen als mark, Sonderzeichen werden maskiert', () => {
  const r = F.markiere('Bei <b>Hans Meier</b> sind es 9 %.', 'nichts');
  const h = F.html(r.segmente);
  assert.ok(h.includes('<mark class="rq-fakt"'));
  assert.ok(h.includes('&lt;b&gt;'));
  assert.ok(!h.includes('<b>'));
});

test('Briefing aus verschachtelten Eingabedaten, leerer Text und kein Briefing', () => {
  assert.equal(F.briefingAus({ a: 'eins', b: { c: ['zwei', 3] } }), 'eins\nzwei');
  assert.equal(F.markiere('', 'x').anzahl, 0);
  const r = F.markiere('Es sind 12 Kunden.', '');
  assert.ok(markiert(r).length >= 1);
});
