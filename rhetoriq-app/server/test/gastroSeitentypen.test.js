// Seitentyp-Bibliothek für Gastronomie-Webseiten: Pflichtfelder, Seitensätze, Pfadzuordnung, Prompt, Parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SEITENTYPEN, SEITENSAETZE, FAKTEN_KEYS, seitentypFuerPfad, promptFuer, parseAusgabe } = require('../lib/gastroSeitentypen');

const GRUPPEN = ['Kern', 'Kulinarik', 'Anlässe', 'Events', 'Service'];
const PFLICHT_TYPEN = ['startseite', 'ueber_uns', 'geschichte', 'speisekarte_intro', 'mittag', 'brunch', 'nachmittag_tea', 'bar_wein',
  'bankette', 'firmenanlass', 'privatanlass', 'hochzeit', 'meetings', 'silvester', 'weihnachten', 'events_aktion', 'reservation',
  'anreise_kontakt', 'team_karriere', 'faq', 'familien', 'terrasse', 'catering', 'gutscheine', 'gruppe_startseite', 'gruppe_restaurants_uebersicht'];

test('alle geforderten Seitentypen existieren mit allen Pflichtfeldern', () => {
  for (const k of PFLICHT_TYPEN) assert.ok(SEITENTYPEN[k], 'fehlt: ' + k);
  for (const [k, t] of Object.entries(SEITENTYPEN)) {
    assert.equal(t.key, k);
    assert.ok(t.label && t.ziel && t.einstieg && t.cta, k);
    assert.ok(GRUPPEN.includes(t.gruppe), k);
    assert.ok(Array.isArray(t.aufbau) && t.aufbau.length >= 2, k);
    t.aufbau.forEach(a => assert.ok(a.h2 && a.inhalt, k));
    assert.ok(t.laengeWoerter.length === 2 && t.laengeWoerter[0] < t.laengeWoerter[1], k);
    assert.ok(t.suchbegriffe.length >= 2 && t.faqFragen.length >= 2 && t.pfadMuster.length >= 1, k);
    t.pflichtFakten.forEach(f => assert.ok(FAKTEN_KEYS.includes(f), k + ': ' + f));
    t.pfadMuster.forEach(m => new RegExp(m));
  }
});

test('Seitensätze verweisen nur auf existierende Typen', () => {
  for (const n of ['restaurant_standard', 'restaurant_gross', 'restaurant_klein', 'gruppe']) assert.ok(SEITENSAETZE[n], n);
  for (const [n, liste] of Object.entries(SEITENSAETZE)) liste.forEach(k => assert.ok(SEITENTYPEN[k], n + ': ' + k));
});

test('seitentypFuerPfad ordnet reale Pfade zu', () => {
  const faelle = {
    '/bankette/': 'bankette', '/de/bankette/': 'bankette', '/de/ueber-uns/': 'ueber_uns', '/firmenanlass/': 'firmenanlass',
    '/privatanlass/': 'privatanlass', '/mittag/': 'mittag', '/lunch/': 'mittag', '/silvester/': 'silvester',
    '/hochzeit/': 'hochzeit', '/speisekarte/': 'speisekarte_intro', '/brunch/': 'brunch', '/carlton-bar/': 'bar_wein',
    '/seminare/': 'meetings', '/de/kontakt/': 'anreise_kontakt', '/faq': 'faq', '/': 'startseite', '/de/': 'startseite',
    'https://www.carlton.ch/de/weihnachten/?x=1': 'weihnachten',
  };
  for (const [p, k] of Object.entries(faelle)) assert.equal(seitentypFuerPfad(p), k, p);
  assert.equal(seitentypFuerPfad('/impressum/'), null);
});

test('promptFuer enthält Format, Längen, Regeln und keine Gedankenstriche', () => {
  for (const k of Object.keys(SEITENTYPEN)) {
    const p = promptFuer(k, { restaurantName: 'Carlton', ort: 'Zürich', kueche: 'Schweizer Küche', faktenText: 'Telefon: 044 000 00 00' });
    for (const s of ['TITEL:', 'BESCHREIBUNG:', 'H1:', 'TEXT:', 'FAQ:', 'F:', 'A:', '60 Zeichen', '120 und 155', 'AUF EINEN BLICK', 'CALL-TO-ACTION', 'Lücke']) assert.ok(p.includes(s), k + ' ohne ' + s);
    assert.ok(!/[–—]/.test(p), k + ' Gedankenstrich');
    assert.ok(!p.includes('ß'), k);
  }
  const p = promptFuer('mittag', { restaurantName: 'X – Y', bestehenderText: 'Alter Text — mit Strich' });
  assert.ok(!/[–—]/.test(p));
  assert.ok(p.includes('BESTEHENDER TEXT') && p.includes('überarbeiten statt neu schreiben'));
  assert.throws(() => promptFuer('gibt_es_nicht', {}));
});

test('parseAusgabe verarbeitet vollständige und unvollständige Ausgaben', () => {
  const voll = `TITEL: Bankette in Zürich | Carlton
BESCHREIBUNG: Feiern Sie Ihr Fest im Carlton.
H1: Bankette in Zürich
TEXT:
Der Saal ist gedeckt.
H2: Räume und Platz
Bis zu [Lücke: Plätze] Gäste.
FAQ:
F: Wie viele Personen?
A: Bis zu [Lücke: Zahl].
F: Wann anfragen?
A: Möglichst früh,
am besten drei Monate vorher.`;
  const r = parseAusgabe(voll);
  assert.equal(r.titel, 'Bankette in Zürich | Carlton');
  assert.equal(r.h1, 'Bankette in Zürich');
  assert.deepEqual(r.h2, ['Räume und Platz']);
  assert.ok(r.text.includes('Der Saal ist gedeckt.'));
  assert.equal(r.faq.length, 2);
  assert.ok(r.faq[1].antwort.includes('drei Monate'));
  assert.equal(r.luecken.length, 2);
  const teil = parseAusgabe('TITEL: Nur Titel');
  assert.equal(teil.titel, 'Nur Titel');
  assert.deepEqual(teil.faq, []);
  for (const leer of ['', null, undefined, 'Freitext ohne Kopfzeilen']) assert.doesNotThrow(() => parseAusgabe(leer));
});
