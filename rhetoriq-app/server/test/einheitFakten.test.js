// Strukturiertes Faktenblatt: Normalisierung, Zeitformat, Auf einen Blick, JSON-LD, fehlende Angaben.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/einheitFakten');

const voll = {
  strasse: 'Seestrasse 12', plz: '6003', ort: 'Luzern', telefon: '+41 41 123 45 67',
  reservation_url: 'https://example.ch/reservation', webseite_url: 'https://example.ch', kueche: 'Saisonale Schweizer Küche',
  preisklasse: 'CHF 30 bis 60', terrasse: true, besonderheiten: ['Seesicht', 'Eigene Konditorei'],
  oeffnungszeiten: [{ tage: ['Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], von: '11:00', bis: '23:00' }]
};
const e = { name: 'Restaurant Seeblick', ort: 'Luzern' };

test('Zeiten lesbar auf Deutsch mit «bis»', () => {
  const z = F.aufEinenBlick(e, voll).find(r => r.label === 'Öffnungszeiten').wert;
  assert.ok(z.startsWith('Di bis So 11:00 bis 23:00 Uhr'), z);
  assert.ok(z.includes('Ruhetag: Mo'));
  const z2 = F.aufEinenBlick({ name: 'X' }, { oeffnungszeiten: [{ tage: ['Mo', 'Mi', 'Fr'], von: '9:00', bis: '12:30' }, { tage: ['Sa', 'So'], von: '10:00', bis: '16:00', bemerkung: 'Brunch' }] })[0].wert;
  assert.ok(z2.startsWith('Mo, Mi und Fr 09:00 bis 12:30 Uhr, Sa und So 10:00 bis 16:00 Uhr (Brunch)'), z2);
});

test('normalisiere bereinigt, meldet Fehler und wirft nie', () => {
  for (const x of [null, undefined, 5, 'x', [], { plz: {} }]) assert.doesNotThrow(() => F.normalisiere(x));
  const r = F.normalisiere({ plz: '60', webseite_url: 'javascript:alert(1)', reservation_url: 'ftp://x.ch', telefon: '  044 – 123  ', kapazitaet_innen: '80', terrasse: 'ja',
    oeffnungszeiten: [{ tage: ['Mo'], von: '25:00', bis: '12:00' }, { tage: [], von: '10:00', bis: '11:00' }, { tage: ['Fr', 'Mo'], von: '10:00', bis: '11:00' }],
    besonderheiten: ['A', 'A', ' ', 'B'] });
  assert.equal(r.fehler.length, 5);
  assert.equal(r.fakten.plz, undefined);
  assert.equal(r.fakten.webseite_url, undefined);
  assert.equal(r.fakten.telefon, '044-123', 'Gedankenstrich wird ersetzt');
  assert.equal(r.fakten.kapazitaet_innen, 80);
  assert.equal(r.fakten.terrasse, true);
  assert.deepEqual(r.fakten.oeffnungszeiten, [{ tage: ['Mo', 'Fr'], von: '10:00', bis: '11:00' }]);
  assert.deepEqual(r.fakten.besonderheiten, ['A', 'B']);
  assert.equal(F.normalisiere(voll).fehler.length, 0);
});

test('Auf einen Blick: feste Reihenfolge, keine Gedankenstriche', () => {
  const z = F.aufEinenBlick(e, voll);
  assert.deepEqual(z.map(r => r.label), ['Adresse', 'Telefon', 'Öffnungszeiten', 'Küche', 'Reservation', 'Besonderheiten']);
  assert.equal(z[0].wert, 'Seestrasse 12, 6003 Luzern');
  assert.ok(!/[–—]/.test(JSON.stringify(z)));
  assert.deepEqual(F.aufEinenBlick({ name: 'X' }, {}), []);
  assert.deepEqual(F.aufEinenBlick({ name: 'X', ort: 'Bern' }, undefined), [{ label: 'Adresse', wert: 'Bern' }]);
});

test('JSON-LD ist gültig, enthält nur Vorhandenes und optional FAQPage', () => {
  const o = JSON.parse(F.jsonLd(e, voll));
  assert.equal(o['@context'], 'https://schema.org');
  assert.equal(o['@type'], 'Restaurant');
  assert.equal(o.name, 'Restaurant Seeblick');
  assert.equal(o.address['@type'], 'PostalAddress');
  assert.equal(o.address.addressCountry, 'CH');
  assert.equal(o.address.postalCode, '6003');
  assert.equal(o.telephone, voll.telefon);
  assert.equal(o.servesCuisine, 'Saisonale Schweizer Küche');
  assert.equal(o.url, 'https://example.ch');
  assert.deepEqual(o.openingHoursSpecification[0].dayOfWeek, ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.equal(o.openingHoursSpecification[0].opens, '11:00');
  assert.equal(o.hasMenu, undefined);
  assert.equal(o.email, undefined, 'nichts erfunden');
  const mini = JSON.parse(F.jsonLd({ name: 'Mini' }, {}));
  assert.equal(mini.telephone, undefined);
  assert.equal(mini.openingHoursSpecification, undefined);
  const g = JSON.parse(F.jsonLd(e, voll, { faq: [{ frage: 'Gibt es eine Terrasse?', antwort: 'Ja.' }, { frage: '', antwort: 'x' }] }));
  assert.ok(Array.isArray(g));
  assert.equal(g[1]['@type'], 'FAQPage');
  assert.equal(g[1].mainEntity.length, 1);
});

test('fehlendeFakten und faktenText', () => {
  assert.deepEqual(F.fehlendeFakten({}).map(x => x.key), ['strasse', 'plz', 'ort', 'telefon', 'oeffnungszeiten', 'kueche', 'reservation_url']);
  assert.deepEqual(F.fehlendeFakten(voll), []);
  assert.deepEqual(F.fehlendeFakten({ ort: 'Bern' }, ['ort', 'email']).map(x => x.key), ['email']);
  const t = F.faktenText(e, voll);
  assert.ok(t.includes('Adresse: Seestrasse 12, 6003 Luzern'));
  assert.ok(t.includes('Terrasse: ja'));
  assert.equal(F.faktenText(e, {}), '');
  assert.ok(F.FAKTEN_FELDER.every(f => f.key && f.label && f.typ));
});
