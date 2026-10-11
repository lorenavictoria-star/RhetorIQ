// Terminbuchung: Verfügbarkeit als reine Berechnung (Wochenende, Feiertag, Ferien, Puffer, Vorlauf, Sommerzeit, besetzte Zeiten).
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../lib/zeit');
const B = require('../lib/buchung');
const T = require('../lib/tagesplan');
const { lies, expandiere } = require('../lib/icsLesen');

const S = B.einstellungen({ aktiv: true });
const JETZT = new Date('2026-10-12T06:00:00Z'); // Montag 08:00 Schweizer Zeit
const frei = () => ({ ganz: false, iv: [] });
const rechne = (o = {}) => B.freieZeiten({ jetzt: o.jetzt || JETZT, s: o.s || S, belegung: o.belegung || frei });
const zeiten = (liste, datum) => liste.filter(z => z.datum === datum).map(z => Z.hhmm(z.beginn));

test('Standard: Montag bis Freitag 09:00 bis 16:00, Pause 12:00 bis 13:00, Raster 30 Minuten, Gespräch 20 Minuten', () => {
  const l = rechne();
  assert.deepEqual(zeiten(l, '2026-10-13'), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
  assert.equal(S.dauer, 20); assert.equal(S.puffer, 15); assert.equal(S.vorlauf, 12); assert.equal(S.horizont, 14); assert.equal(S.raster, 30);
  assert.equal(S.aktiv, true); assert.equal(B.einstellungen({}).aktiv, false, 'Standard ist AUS');
});

test('Wochenenden sind nie buchbar, auch nicht wenn sie eingestellt werden', () => {
  const s = B.einstellungen({ aktiv: true, tage: { 6: { an: true, von: 540, bis: 960 }, 7: { an: true, von: 540, bis: 960 } } });
  assert.equal(s.tage[6].an, false); assert.equal(s.tage[7].an, false);
  const l = rechne({ s });
  assert.ok(l.length > 0);
  for (const z of l) assert.ok(Z.wd(z.datum) <= 5, z.datum);
  assert.deepEqual(zeiten(l, '2026-10-17'), []); assert.deepEqual(zeiten(l, '2026-10-18'), []);
});

test('Feiertag: Weihnachten und Stephanstag sind frei', () => {
  const l = rechne({ jetzt: new Date('2026-12-21T06:00:00Z') });
  assert.deepEqual(zeiten(l, '2026-12-25'), []);
  assert.deepEqual(zeiten(l, '2026-12-26'), []);
  assert.ok(zeiten(l, '2026-12-24').length > 0);
});

test('Ferien und eigene Feiertage sperren den ganzen Tag', () => {
  const ferien = [{ typ: 'ferien', titel: 'Ferien', ganztaegig: true, beginn: null, ende: null }];
  const l = rechne({ belegung: (d) => (d === '2026-10-14' ? B.belegungAus(ferien) : frei()) });
  assert.deepEqual(zeiten(l, '2026-10-14'), []);
  assert.ok(zeiten(l, '2026-10-15').length > 0);
});

test('Puffer: 15 Minuten vor und nach jedem Termin bleiben frei', () => {
  const bel = B.belegungAus([{ typ: 'kunde', titel: 'Termin', beginn: 600, ende: 660, ganztaegig: false }]); // 10:00 bis 11:00
  const l = rechne({ belegung: (d) => (d === '2026-10-13' ? bel : frei()) });
  assert.deepEqual(zeiten(l, '2026-10-13').slice(0, 3), ['09:00', '11:30', '13:00']);
  // 09:30 endet 09:50 und reicht mit dem Puffer in den Termin, 11:00 beginnt im Puffer danach
  const ohnePuffer = rechne({ s: B.einstellungen({ aktiv: true, puffer: 0 }), belegung: (d) => (d === '2026-10-13' ? bel : frei()) });
  assert.deepEqual(zeiten(ohnePuffer, '2026-10-13').slice(0, 4), ['09:00', '09:30', '11:00', '11:30']);
});

test('Mindestvorlauf 12 Stunden', () => {
  const l = rechne(); // Montag 08:00: frühestens Montag 20:00, also Dienstag
  assert.deepEqual(zeiten(l, '2026-10-12'), []);
  assert.equal(zeiten(l, '2026-10-13')[0], '09:00');
  // genau 12 Stunden zählen als frei: jetzt Montag 21:00 Schweizer Zeit, Dienstag 09:00 ist exakt 12 Stunden entfernt
  const knapp = rechne({ jetzt: Z.zuDate('2026-10-12', 21 * 60) });
  assert.equal(zeiten(knapp, '2026-10-13')[0], '09:00');
  const zuknapp = rechne({ jetzt: Z.zuDate('2026-10-12', 21 * 60 + 1) });
  assert.equal(zeiten(zuknapp, '2026-10-13')[0], '09:30');
  const ohne = rechne({ s: B.einstellungen({ aktiv: true, vorlauf: 0 }) });
  assert.equal(zeiten(ohne, '2026-10-12')[0], '09:00');
});

test('Horizont: höchstens 14 Tage voraus', () => {
  const l = rechne();
  const letzte = l[l.length - 1];
  assert.ok(letzte.start.getTime() <= JETZT.getTime() + 14 * 86400000);
  assert.ok(Z.tageZwischen('2026-10-12', letzte.datum) <= 14);
});

test('Sommerzeitwechsel im Herbst: gleiche Wanduhrzeit, andere UTC-Zeit', () => {
  const l = rechne({ jetzt: new Date('2026-10-23T05:00:00Z'), s: B.einstellungen({ aktiv: true, vorlauf: 0 }) });
  const fr = l.find(z => z.datum === '2026-10-23' && z.beginn === 540);
  const mo = l.find(z => z.datum === '2026-10-26' && z.beginn === 540);
  assert.equal(fr.start.toISOString(), '2026-10-23T07:00:00.000Z', 'Freitag 09:00 Sommerzeit = 07:00 UTC');
  assert.equal(mo.start.toISOString(), '2026-10-26T08:00:00.000Z', 'Montag 09:00 Winterzeit = 08:00 UTC');
  assert.equal(mo.ende.getTime() - mo.start.getTime(), 20 * 60000);
});

test('Sommerzeitwechsel im Frühling', () => {
  const l = rechne({ jetzt: new Date('2027-03-25T05:00:00Z'), s: B.einstellungen({ aktiv: true, vorlauf: 0 }) });
  assert.equal(l.find(z => z.datum === '2027-03-25' && z.beginn === 540).start.toISOString(), '2027-03-25T08:00:00.000Z');
  assert.equal(l.find(z => z.datum === '2027-03-30' && z.beginn === 540).start.toISOString(), '2027-03-30T07:00:00.000Z');
});

test('Heute wird in Schweizer Zeit bestimmt: Freitag 23:30 UTC ist schon Samstag', () => {
  const l = rechne({ jetzt: new Date('2026-10-16T23:30:00Z'), s: B.einstellungen({ aktiv: true, vorlauf: 0 }) });
  assert.equal(l[0].datum, '2026-10-19', 'erster buchbarer Tag ist der Montag');
});

test('Besetzte Zeiten aus Terminen, Google-Terminen und ICS-Kalendern sperren', () => {
  const eigene = T.eintraegeAm([{ id: 1, titel: 'Workshop', typ: 'kunde', datum: '2026-10-13', beginn: 540, ende: 600, ganztaegig: false, wiederholung: 'keine', wochentage: [], ausnahmen: [] }], '2026-10-13');
  const google = [{ typ: 'fremd', fremd: true, google: true, titel: 'Zahnarzt', beginn: 780, ende: 840, ganztaegig: false, frei: false }];
  const ics = lies(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:a@x', 'DTSTART;TZID=Europe/Zurich:20261013T140000', 'DTEND;TZID=Europe/Zurich:20261013T150000', 'SUMMARY:Intern', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  const fremd = expandiere(ics, '2026-10-13', '2026-10-13').map(t => ({ typ: 'fremd', fremd: true, beginn: t.beginn, ende: t.ende, ganztaegig: t.ganztaegig, frei: !!t.frei }));
  assert.equal(fremd.length, 1);
  const bel = B.belegungAus(eigene.concat(google, fremd));
  const l = rechne({ belegung: (d) => (d === '2026-10-13' ? bel : frei()) });
  const t = zeiten(l, '2026-10-13');
  assert.ok(!t.includes('09:00') && !t.includes('09:30'), 'Workshop mit Puffer');
  assert.ok(!t.includes('13:00') && !t.includes('13:30'), 'Google-Termin');
  assert.ok(!t.includes('14:00') && !t.includes('14:30'), 'ICS-Termin');
  assert.ok(t.includes('10:30') && t.includes('11:00'));
});

test('Als «frei» markierte fremde Termine sperren nicht, ganztägige belegte fremde Termine sperren den Tag', () => {
  assert.deepEqual(B.belegungAus([{ typ: 'fremd', fremd: true, beginn: 600, ende: 660, ganztaegig: false, frei: true }]), { ganz: false, iv: [] });
  assert.equal(B.belegungAus([{ typ: 'fremd', fremd: true, ganztaegig: true, beginn: null, ende: null, frei: false }]).ganz, true);
  assert.equal(B.belegungAus([{ typ: 'fremd', fremd: true, ganztaegig: true, beginn: null, ende: null, frei: true }]).ganz, false);
});

test('Einstellungen: Eingaben werden begrenzt, Unsinn fällt auf den Standard zurück', () => {
  const s = B.einstellungen({ dauer: 5, puffer: -3, vorlauf: 9999, horizont: 'x', raster: 7, kontakt_link: 'javascript:alert(1)', kontakt_text: 'Zeile\r\nzwei – drei' });
  assert.equal(s.dauer, 20); assert.equal(s.puffer, 15); assert.equal(s.vorlauf, 12); assert.equal(s.horizont, 14); assert.equal(s.raster, 30);
  assert.equal(s.kontakt_link, '');
  assert.ok(!/[\r\n–]/.test(s.kontakt_text));
  assert.equal(B.einstellungen({ kontakt_link: 'https://meet.example.ch/abc' }).kontakt_link, 'https://meet.example.ch/abc');
  assert.equal(B.einstellungen({ kontakt_link: 'http://unsicher.ch' }).kontakt_link, '');
  const p = B.einstellungen({ tage: { 2: { an: true, von: 600, bis: 840, pause_von: null, pause_bis: null } } });
  assert.equal(p.tage[2].von, 600); assert.equal(p.tage[2].pause_von, null);
  assert.equal(B.einstellungen({ tage: { 3: { an: false } } }).tage[3].an, false);
});

test('Öffentliche Form enthält nur Zeitpunkte und Beschriftungen', () => {
  const tage = B.nachTagen(rechne());
  assert.ok(tage.length >= 8);
  assert.deepEqual(Object.keys(tage[0]).sort(), ['datum', 'kurz', 'label', 'zeiten']);
  assert.deepEqual(Object.keys(tage[0].zeiten[0]).sort(), ['start', 'zeit']);
  assert.equal(tage[0].label, 'Dienstag, 13. Oktober');
  assert.equal(tage[0].kurz, 'Di 13.10.');
});

test('Zeitfenster-Ticket: gültig, zu alt gerechnet, gefälscht', () => {
  const t = B.ticketNeu(new Date('2026-10-12T06:00:00Z'));
  assert.equal(B.ticketAlter(t, new Date('2026-10-12T06:00:05Z')), 5000);
  assert.equal(B.ticketAlter(t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a'), new Date()), null);
  assert.equal(B.ticketAlter('1.2', new Date()), null);
  assert.equal(B.ticketAlter(undefined, new Date()), null);
});

test('Eingabeprüfung: Pflichtfelder, Format, Länge, Einwilligung', () => {
  const ok = { name: 'Anna Muster', email: 'Anna@Firma.ch', message: 'Hallo', start: '2026-10-13T07:00:00.000Z', einwilligung: true };
  const r = B.pruefeEingabe(ok);
  assert.equal(r.werte.email, 'anna@firma.ch');
  for (const [k, v] of [['name', ''], ['name', 'A'], ['name', 'Bob http://x.ch'], ['name', 'a@b.ch'], ['name', 'x'.repeat(81)], ['email', 'kein-mail'], ['email', 'a b@c.ch'], ['email', 'a@b'], ['email', 'a@b.ch\nBcc: x@y.ch'], ['einwilligung', false], ['einwilligung', 'true'], ['name', ['a', 'b']], ['message', { x: 1 }]]) {
    assert.ok(B.pruefeEingabe({ ...ok, [k]: v }).fehler, `${k}=${JSON.stringify(v)}`);
  }
  assert.ok(B.pruefeEingabe({ ...ok, message: 'x'.repeat(3001) }).fehler);
  assert.equal(B.pruefeEingabe({ ...ok, message: 'Zeile 1\r\nZeile 2\u0000' }).werte.message, 'Zeile 1\nZeile 2');
  assert.equal(B.pruefeEingabe({ ...ok, name: 'Anna\r\nMuster' }).werte.name, 'Anna Muster');
});
