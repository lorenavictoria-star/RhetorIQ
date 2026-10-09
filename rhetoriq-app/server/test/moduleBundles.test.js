const test = require('node:test');
const assert = require('node:assert/strict');
const { toEnabledModules, ALLE_MODULE } = require('../lib/moduleCatalog');

test('Gebündeltes Modul Gespräch schaltet alle vier Einzelschlüssel frei', () => {
  const k = toEnabledModules(['Gespräch']);
  for (const x of ['brand-voice', 'pre-meeting', 'arg-reaction', 'sparring', 'debrief']) assert.ok(k.includes(x), x);
});

test('Rede und Auftritt, Bewertungen und Branchenpakete werden zu Einzelschlüsseln', () => {
  const k = toEnabledModules(['Rede und Auftritt', 'Bewertungen beantworten', 'Branchenpaket Hotellerie', 'Branchenpaket Capital Markets']);
  for (const x of ['text-gen', 'presentation', 'customer-review', 'ht-review-response', 'ht-guest-letter', 'ht-crisis-comm', 'ht-positioning', 'ht-sales-pitch', 'cm-qa-trainer', 'cm-equity-story', 'cm-earnings-analyzer', 'cm-board-coach', 'cm-roadshow']) assert.ok(k.includes(x), x);
  assert.equal(new Set(k).size, k.length);
  // Ohne Branchenpaket bekommt niemand ein Hotel- oder Capital-Markets-Modul
  const ohne = toEnabledModules(['Gespräch', 'Rede und Auftritt', 'Bewertungen beantworten']);
  assert.ok(!ohne.some(x => /^(ht|cm)-/.test(x)));
});

test('Alte Einzelnamen gelten weiter, Unbekanntes wird ignoriert', () => {
  assert.deepEqual(toEnabledModules(['Debrief', 'Meeting-Vorbereitung', 'Unbekannt']).sort(), ['brand-voice', 'debrief', 'pre-meeting']);
  assert.deepEqual(toEnabledModules(undefined), ['brand-voice']);
});

test('Bündelnamen sind im Katalog zugelassen', () => {
  for (const n of ['Gespräch', 'Rede und Auftritt', 'Bewertungen beantworten', 'Branchenpaket Hotellerie', 'Branchenpaket Capital Markets']) assert.ok(ALLE_MODULE.includes(n), n);
});
