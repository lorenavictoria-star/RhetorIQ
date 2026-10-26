// Prüfbibliothek für Webseitentexte: Duplikate, Wiederholungen, Fakten, Seitenqualität, Leistung.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../lib/webseitenCheck');

const BANKETT_A = 'Unser Bankettsaal bietet Platz für achtzig Gäste und eignet sich für Hochzeiten, Firmenanlässe und Familienfeiern. Wir kochen saisonal mit Zutaten aus der Region und beraten Sie persönlich bei der Menüwahl.';
const BANKETT_B = 'Unser Bankettsaal bietet Platz für achtzig Gäste und eignet sich für Hochzeiten, Firmenanlässe und Familienfeiern. Wir kochen saisonal mit Zutaten aus der Region und beraten Sie persönlich bei der Planung Ihres Abends.';
const KONTAKT = 'Reservieren Sie telefonisch oder per Mail. Unser Team antwortet innert eines Tages und hält Ihnen einen Tisch am Fenster frei, wenn Sie das wünschen.';

test('aehnlichkeit: gleich, verschieden, Satzzeichen egal', () => {
  assert.equal(W.aehnlichkeit(BANKETT_A, BANKETT_A), 1);
  assert.ok(W.aehnlichkeit(BANKETT_A, BANKETT_B) > 0.5);
  assert.ok(W.aehnlichkeit(BANKETT_A, KONTAKT) < 0.05);
  assert.equal(W.aehnlichkeit('Hallo, Welt wie geht es dir heute', 'hallo welt WIE geht es dir heute!'), 1);
  assert.equal(W.aehnlichkeit('', 'abc'), 0);
});

test('duplikate: fast gleiche Bankett-Seiten erkannt, unterschiedliche nicht', () => {
  const seiten = [
    { id: 'a1', site: 'Alpha', typ: 'bankett', text: BANKETT_A },
    { id: 'b1', site: 'Beta', typ: 'bankett', text: BANKETT_B },
    { id: 'b2', site: 'Beta', typ: 'kontakt', text: KONTAKT }
  ];
  const d = W.duplikate(seiten);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].a, d[0].b], ['a1', 'b1']);
  assert.equal(d[0].typ, 'bankett');
  assert.ok(d[0].gemeinsameSaetze.length >= 1);
});

test('duplikate: innerhalb einer Webseite auch bei verschiedenem Typ', () => {
  const d = W.duplikate([
    { id: 'x1', site: 'Alpha', typ: 'bankett', text: BANKETT_A },
    { id: 'x2', site: 'Alpha', typ: 'events', text: BANKETT_B }
  ]);
  assert.equal(d.length, 1);
});

test('wiederholungen: wiederkehrende Phrase und herzlich willkommen', () => {
  const mk = (id, site, t) => ({ id, site, typ: 'start', text: t });
  const seiten = [
    mk('1', 'Alpha', 'Bei uns schmeckt Ihr Abend mit eine gewisse Prise Coolness im Glas. Herzlich willkommen im Haus.'),
    mk('2', 'Beta', 'Die Bar lebt mit eine gewisse Prise Coolness an jedem Abend. Herzlich willkommen bei uns.'),
    mk('3', 'Gamma', 'Dazu kommt eine gewisse Prise Coolness im Service. Herzlich willkommen am See.'),
    mk('4', 'Gamma', 'Ein ganz anderer Text über Weine aus dem Wallis.')
  ];
  const r = W.wiederholungen(seiten);
  assert.ok(r.some(x => x.phrase.includes('gewisse prise coolness') && x.anzahlSeiten === 3));
  assert.ok(r.some(x => x.phrase === 'herzlich willkommen'));
  assert.ok(!r.some(x => x.phrase.includes('weine aus dem')));
});

test('wiederholungen: Stoppwort-Folgen und Namen werden ignoriert', () => {
  const mk = (id, site, t) => ({ id, site, typ: 'start', text: t });
  const seiten = [
    mk('1', 'Hotel Sonne Zürich', 'Hotel Sonne Zürich ist und in der Nähe von dem See.'),
    mk('2', 'Hotel Sonne Zürich', 'Hotel Sonne Zürich ist und in der Nähe von dem See.'),
    mk('3', 'Bar Mond', 'Hotel Sonne Zürich ist und in der Nähe von dem See.')
  ];
  assert.deepEqual(W.wiederholungen(seiten, { minSites: 1 }).filter(x => /ist und in der|hotel sonne/.test(x.phrase)), []);
});

test('faktenKonflikte: Telefon und PLZ', () => {
  const fakten = { Alpha: { strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich', telefon: '+41 44 123 45 67', oeffnungszeiten: [{ tage: 'Mo-Fr', von: '11:00', bis: '22:00' }] } };
  const seiten = [
    { id: 'k1', site: 'Alpha', typ: 'kontakt', text: 'Rufen Sie uns an: 044 123 45 68. Wir sind in 8002 Zürich. Montag bis Freitag 11:00 bis 23:00 Uhr.' },
    { id: 'k2', site: 'Alpha', typ: 'kontakt', text: 'Telefon 044 123 45 67, Bahnhofstrasse 12, 8001 Zürich, 11–22 Uhr.' },
    { id: 'k3', site: 'Alpha', typ: 'kontakt', text: 'Bahnhofstrasse 14 in Zürich.' }
  ];
  const k = W.faktenKonflikte(seiten, fakten);
  assert.ok(k.some(x => x.art === 'telefon' && x.seiteId === 'k1'));
  assert.ok(k.some(x => x.art === 'plz' && x.gefunden === '8002 Zürich'));
  assert.ok(k.some(x => x.art === 'zeit' && x.seiteId === 'k1'));
  assert.ok(k.some(x => x.art === 'adresse' && x.seiteId === 'k3'));
  assert.ok(!k.some(x => x.seiteId === 'k2'));
});

const GUT = {
  id: 'g', site: 'Alpha', typ: 'start',
  titel: 'Restaurant Alpha in Zürich',
  beschreibung: 'Saisonale Küche am See in Zürich: Frische Zutaten aus der Region, ein ruhiger Garten und ein Team, das Ihren Abend mit Sorgfalt plant und begleitet.',
  h1: 'Saisonal kochen am See',
  h2: ['Küche'],
  text: 'Wir kochen mit dem, was die Region gerade liefert. Der Garten liegt direkt am Wasser. ' + 'Gäste reservieren online oder per Telefon. '.repeat(3),
  faq: [{ frage: 'Gibt es Parkplätze?', antwort: 'Ja, vor dem Haus.' }]
};

test('seitenQualitaet: guter Datensatz', () => {
  const q = W.seitenQualitaet(GUT, { ziel: { laengeWoerter: [20, 100], faqNoetig: true } });
  assert.equal(GUT.beschreibung.length >= 120 && GUT.beschreibung.length <= 155, true);
  assert.deepEqual(q.hinweise.filter(h => h.stufe === 'fehler'), []);
  assert.equal(q.ok, true);
  assert.deepEqual(q.luecken, []);
});

test('seitenQualitaet: schlechter Datensatz', () => {
  const schlecht = {
    id: 's', site: 'Alpha', typ: 'bankett',
    titel: 'Unser wunderschönes Bankett im Herzen der Stadt Zürich: Herzlich willkommen',
    beschreibung: 'Kurz.', h1: '', text: 'Herzlich willkommen [Name einfügen]. Wir kochen frisch, wir lieben Gäste. Das beste Essen der Stadt – unvergesslich.', faq: []
  };
  const q = W.seitenQualitaet(schlecht, { ziel: { laengeWoerter: [100, 300], faqNoetig: true } });
  const arten = q.hinweise.map(h => h.art);
  for (const a of ['h1', 'titel', 'beschreibung', 'laenge', 'platzhalter', 'gedankenstrich', 'floskel', 'komma', 'superlativ', 'faq']) {
    assert.ok(arten.includes(a), 'fehlt: ' + a);
  }
  assert.equal(q.ok, false);
  assert.deepEqual(q.luecken, ['[Name einfügen]']);
  assert.equal(q.hinweise.find(h => h.art === 'komma').stufe, 'hinweis');
});

test('seitenQualitaet: langer Gedankenstrich und Floskel', () => {
  const q = W.seitenQualitaet({ ...GUT, text: 'Wir freuen uns auf Sie — kommen Sie vorbei. Kulinarische Perlen warten.' });
  assert.ok(q.hinweise.some(h => h.art === 'gedankenstrich' && h.stufe === 'fehler'));
  assert.ok(q.hinweise.filter(h => h.art === 'floskel').length >= 2);
});

test('zusammenfassung: Gesamtbericht', () => {
  const seiten = [GUT, { ...GUT, id: 'g2', site: 'Beta', text: GUT.text + ' [Adresse]' }];
  const z = W.zusammenfassung(seiten, { ziel: { laengeWoerter: [10, 200] } });
  assert.equal(z.anzahlSeiten, 2);
  assert.ok(z.fehler >= 1);
  assert.ok(z.luecken instanceof Map);
  assert.equal(z.luecken.get('Beta')[0].seiteId, 'g2');
  assert.ok(Array.isArray(z.duplikate) && Array.isArray(z.wiederholungen) && Array.isArray(z.konflikte));
});

test('Leistung: 120 Seiten à 300 Wörter unter 2 Sekunden', () => {
  const vokabel = Array.from({ length: 800 }, (_, i) => 'wort' + i.toString(36) + 'x');
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const seiten = Array.from({ length: 120 }, (_, i) => ({
    id: 'p' + i, site: 'Site' + (i % 4), typ: 't' + (i % 5), titel: 'Titel ' + i, beschreibung: '', h1: 'H' + i, h2: [],
    text: Array.from({ length: 300 }, () => vokabel[Math.floor(rnd() * vokabel.length)]).join(' ') + '.', faq: []
  }));
  const t0 = Date.now();
  W.zusammenfassung(seiten, { faktenProSite: { Site0: { telefon: '044 111 22 33', plz: '8000', ort: 'Zürich' } } });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `dauerte ${ms} ms`);
});
