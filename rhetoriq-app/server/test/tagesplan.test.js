// Tagesplan: Fristen, Start, Mittag, Reihenfolge, Termine, freie Tage, Dauer, ICS, Token, Mail, Rolle, Assistent-Aktionen.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const Z = require('../lib/zeit');
const T = require('../lib/tagesplan');
const { baueIcs, maskiere, falte } = require('../lib/ics');
const A = require('../lib/assistent');
const AP = require('../lib/assistentPlan');

const S = T.einstellungen({});
const DI = '2026-10-13'; // Dienstag
const SA = '2026-10-17'; // Samstag
const at = (datum, hhmm) => Z.zuDate(datum, Z.zeitZuMin(hhmm));
const frg = (key, paket, eingang, extra = {}) => ({ key, typ: 'freigabe', klient: 'Firma ' + key, textart: 'Text', paket, eingang, dauer: 20, dauerQuelle: 'standard', ...extra });
const plan = (aufgaben, o = {}) => T.planBauen(aufgaben, { datum: DI, settings: S, jetzt: at(DI, '07:00'), eintraege: [], ...o });
const hm = (p, key) => p.items.find(i => i.key === key);

test('Fristen: 3 Stunden für Team, Business, Enterprise, nächster Werktag für Stimme', () => {
  const e = at(DI, '09:00');
  for (const p of ['team', 'business', 'enterprise']) assert.equal(Z.zurich(T.fristBerechnen(e, p, [], S)).min, 12 * 60, p);
  const st = Z.zurich(T.fristBerechnen(e, 'stimme', [], S));
  assert.equal(st.datum, '2026-10-14');
  assert.equal(Z.zurich(T.fristBerechnen(at('2026-10-16', '10:00'), 'stimme', [], S)).datum, '2026-10-19', 'Freitag, dann Montag');
});

test('Fristen laufen nur an Werktagen', () => {
  const abends = Z.zurich(T.fristBerechnen(at(DI, '17:00'), 'team', [], S));
  assert.deepEqual(abends, { datum: '2026-10-14', min: 8 * 60 + 120 }, '1 Stunde am Dienstag, 2 Stunden am Mittwoch');
  const we = Z.zurich(T.fristBerechnen(at(SA, '10:00'), 'business', [], S));
  assert.deepEqual(we, { datum: '2026-10-19', min: 11 * 60 });
  const feiertag = Z.zurich(T.fristBerechnen(at('2026-07-31', '17:30'), 'team', [], S));
  assert.equal(feiertag.datum, '2026-08-03', '1. August übersprungen');
});

test('Feiertage und Ferien', () => {
  assert.equal(Z.feiertagName('2026-04-03'), 'Karfreitag');
  assert.equal(Z.feiertagName('2026-05-14'), 'Auffahrt');
  assert.equal(Z.feiertagName('2026-12-26'), 'Stephanstag');
  const ferien = [{ id: 1, titel: 'Ferien', typ: 'ferien', datum: '2026-10-12', ganztaegig: true, wiederholung: 'taeglich', bis: '2026-10-19', wochentage: [] }];
  assert.equal(T.arbeitstag(DI, ferien).ja, false);
  assert.equal(T.arbeitstag('2026-10-20', ferien).ja, true);
  const eigener = [{ id: 2, titel: 'Brückentag', typ: 'feiertag', datum: DI, ganztaegig: true, wiederholung: 'keine', wochentage: [] }];
  assert.equal(T.arbeitstag(DI, eigener).grund, 'Brückentag');
});

test('Start 07:30 bei Dringlichem, sonst 08:00; Mittagspause', () => {
  const ruhig = plan([frg('a', 'team', at(DI, '07:00'))]); // Frist 10:00, nicht in unter 1,5 Stunden ab 08:00
  assert.equal(ruhig.start, '08:00');
  assert.equal(ruhig.fruehStart, false);
  const eil = plan([frg('a', 'team', at('2026-10-12', '16:00'))]); // Frist Dienstag 09:00
  assert.equal(eil.fruehStart, true);
  assert.equal(eil.start, '07:30');
  assert.equal(plan([frg('e', 'enterprise', at(DI, '07:00'))]).start, '07:30', 'Enterprise');
  assert.equal(plan([frg('a', 'team', at(DI, '07:00'), { dringlich: true })]).start, '07:30', 'manuell dringlich');
  // Mittag: acht Aufgaben zu 30 Minuten reichen über 12:00
  const viele = plan(Array.from({ length: 8 }, (_, i) => ({ key: 'n' + i, typ: 'anfrage', klient: 'K' + i, textart: 'Anfrage', paket: null, dauer: 30 })));
  for (const i of viele.items) assert.ok(i.ende <= 720 || i.beginn >= 780, 'nie in der Mittagspause');
  assert.ok(viele.items.some(i => i.beginn === 780));
});

test('Reihenfolge: Überfälliges, Frist, Paket, kurz vor lang, Fristloses zuletzt', () => {
  const p = plan([
    { key: 'tp', typ: 'themenplan', klient: 'T', textart: 'Themenplan', paket: null, dauer: 30 },
    frg('spaet', 'team', at(DI, '08:00')),
    frg('alt', 'team', at('2026-10-09', '10:00')),
    frg('gleichT', 'team', at(DI, '07:00'), { frist: at(DI, '12:00') }),
    frg('gleichB', 'business', at(DI, '07:00'), { frist: at(DI, '12:00') }),
    frg('kurz', 'team', at(DI, '07:00'), { frist: at(DI, '13:30'), dauer: 10 }),
    frg('lang', 'team', at(DI, '07:00'), { frist: at(DI, '13:30'), dauer: 40 })
  ]);
  assert.deepEqual(p.items.map(i => i.key), ['alt', 'spaet', 'gleichB', 'gleichT', 'kurz', 'lang', 'tp']);
  assert.ok(hm(p, 'alt').ueberfaellig);
});

test('Frist nicht haltbar: rot markiert', () => {
  const p = plan(Array.from({ length: 4 }, (_, i) => frg('f' + i, 'team', at(DI, '07:00'), { frist: at(DI, '09:00'), dauer: 30 })));
  assert.equal(p.verspaetet, 1);
  assert.equal(hm(p, 'f0').verspaetet, false);
  assert.equal(hm(p, 'f3').verspaetet, true);
});

test('Planen um Termine herum, auch wiederkehrende', () => {
  const eintraege = [
    { id: 1, titel: 'Sport', typ: 'sport', datum: '2026-10-06', beginn: 8 * 60, ende: 9 * 60, ganztaegig: false, wiederholung: 'woechentlich', wochentage: [2], bis: null },
    { id: 2, titel: 'Kunde', typ: 'kunde', datum: DI, beginn: 9 * 60 + 30, ende: 10 * 60, ganztaegig: false, wiederholung: 'keine', wochentage: [] }
  ];
  const p = plan([frg('a', 'team', at(DI, '07:00')), frg('b', 'team', at(DI, '07:00')), frg('c', 'team', at(DI, '07:00'))], { eintraege });
  assert.equal(p.bloecke.length, 2);
  for (const i of p.items) for (const b of p.bloecke) assert.ok(i.ende <= b.beginn || i.beginn >= b.ende, `${i.key} liegt im Block ${b.titel}`);
  assert.equal(hm(p, 'a').start, '09:00', 'erst nach dem Sport');
  assert.equal(plan([frg('a', 'team', at(DI, '07:00'))], { datum: '2026-10-20', eintraege, jetzt: at('2026-10-20', '07:00') }).bloecke[0].titel, 'Sport', 'Wiederholung wöchentlich');
  assert.equal(plan([], { datum: '2026-10-14', eintraege }).bloecke.length, 0);
});

test('Wochenende, Feiertag, Ferien: kein Plan ausser Dringliches oder Enterprise', () => {
  const normal = [frg('a', 'team', at('2026-10-16', '10:00'))];
  const sa = T.planBauen(normal, { datum: SA, settings: S, jetzt: at(SA, '07:00'), eintraege: [] });
  assert.equal(sa.leer, true);
  assert.equal(sa.arbeitstag, false);
  const dringend = T.planBauen([...normal, frg('d', 'team', at('2026-10-16', '10:00'), { dringlich: true })], { datum: SA, settings: S, jetzt: at(SA, '07:00'), eintraege: [] });
  assert.deepEqual(dringend.items.map(i => i.key), ['d']);
  const ent = T.planBauen([frg('e', 'enterprise', at('2026-10-16', '10:00'))], { datum: SA, settings: S, jetzt: at(SA, '07:00'), eintraege: [] });
  assert.equal(ent.items.length, 1);
  const ferien = [{ id: 1, titel: 'Ferien', typ: 'ferien', datum: '2026-10-12', ganztaegig: true, wiederholung: 'taeglich', bis: '2026-10-19', wochentage: [] }];
  assert.equal(plan(normal, { eintraege: ferien }).leer, true);
  assert.equal(plan([frg('e', 'enterprise', at(DI, '07:00'))], { eintraege: ferien }).items.length, 1);
  const feier = T.planBauen(normal, { datum: '2026-08-01', settings: S, jetzt: at('2026-08-01', '07:00'), eintraege: [] });
  assert.equal(feier.leer, true);
});

test('Von Hand verschobene Aufgabe bleibt, der Rest plant darum herum', () => {
  const p = plan([frg('a', 'team', at(DI, '07:00')), frg('b', 'team', at(DI, '07:00'))], { positionen: { a: { datum: DI, beginn: 8 * 60 } } });
  assert.equal(hm(p, 'a').fixiert, true);
  assert.equal(hm(p, 'a').start, '08:00');
  assert.ok(hm(p, 'b').beginn >= 8 * 60 + 20);
  const andererTag = plan([frg('a', 'team', at(DI, '07:00'))], { positionen: { a: { datum: '2026-10-14', beginn: 600 } } });
  assert.equal(hm(andererTag, 'a').fixiert, false);
});

test('Einträge: strenge Prüfung', () => {
  const ok = T.eintragPruefen({ titel: 'Sport', typ: 'sport', datum: DI, beginn: '17:00', ende: '18:00' }, { settings: S, heute: DI });
  assert.ok(ok.eintrag);
  for (const bad of [{ titel: '' }, { titel: 'x', datum: '2026-02-30', beginn: '1:00', ende: '2:00' }, { titel: 'x', datum: DI, beginn: '18:00', ende: '17:00' },
    { titel: 'x', datum: DI, beginn: '25:00', ende: '26:00' }, { titel: 'x', datum: DI, beginn: '17:00', ende: '18:00', typ: 'boese' },
    { titel: 'x', datum: DI, beginn: '17:00', ende: '18:00', wiederholung: 'jaehrlich' }, { titel: 'x', datum: DI, beginn: '17:00', ende: '18:00', bis: '2026-10-01', wiederholung: 'taeglich' }]) {
    assert.ok(T.eintragPruefen(bad, { settings: S, heute: DI }).fehler, JSON.stringify(bad));
  }
  assert.equal(T.eintragPruefen({ titel: 'F – Ferien', typ: 'ferien', datum: DI }, { settings: S }).eintrag.titel, 'F, Ferien', 'keine Gedankenstriche');
  assert.equal(T.eintragPruefen({ titel: 'F', typ: 'ferien', datum: DI }, { settings: S }).eintrag.ganztaegig, true);
});

test('ICS: Aufbau, Maskierung, Faltung, Zeitzone, keine Gedankenstriche', () => {
  const ics = baueIcs([{ uid: 'rq-r1@rhetoriq.ch', datum: DI, beginn: 480, ende: 500, titel: 'Müller; AG, Text – Rede', beschreibung: 'Zeile eins\nZeile, zwei ' + 'x'.repeat(200), url: 'https://app.test/#ws=1' }], { jetzt: new Date('2026-10-13T05:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Zurich/);
  assert.match(ics, /DTSTART;TZID=Europe\/Zurich:20261013T080000\r\n/);
  assert.match(ics, /DTEND;TZID=Europe\/Zurich:20261013T082000\r\n/);
  assert.match(ics, /DTSTAMP:20261013T050000Z/);
  assert.match(ics, /UID:rq-r1@rhetoriq\.ch/);
  assert.match(ics, /SUMMARY:Müller\\; AG\\, Text\\, Rede/);
  assert.match(ics, /Zeile eins\\nZeile\\, zwei/);
  assert.match(ics, /URL:https:\/\/app\.test\/#ws=1/);
  assert.doesNotMatch(ics, /[–—]/);
  for (const z of ics.split('\r\n')) assert.ok(Buffer.byteLength(z) <= 75, 'gefaltet: ' + z.length);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  const f = falte('SUMMARY:' + 'ä'.repeat(100));
  assert.ok(f.split('\r\n').every(z => Buffer.byteLength(z) <= 75));
  assert.equal(f.replace(/\r\n /g, ''), 'SUMMARY:' + 'ä'.repeat(100), 'Faltung verlustfrei');
  assert.equal(maskiere('a\\b'), 'a\\\\b');
});

test('Zeitzone: Sommer- und Winterzeit', () => {
  assert.equal(Z.zuDate('2026-10-13', 480).toISOString(), '2026-10-13T06:00:00.000Z');
  assert.equal(Z.zuDate('2026-12-15', 480).toISOString(), '2026-12-15T07:00:00.000Z');
});

// ── Datenbank, Routen, Job ──
let srv, kl, kb, ke;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await H.pool.query(`CREATE TABLE inquiries (id SERIAL PRIMARY KEY, name TEXT, company TEXT, status TEXT NOT NULL DEFAULT 'neu', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await require('../lib/schemaRedesign').ensureSchema();
  kl = await H.addClient('Team AG'); kb = await H.addClient('Business AG'); ke = await H.addClient('Enterprise AG');
  await H.pool.query(`UPDATE clients SET recommended_plan='team' WHERE id=$1`, [kl.id]);
  await H.pool.query(`UPDATE clients SET recommended_plan='business' WHERE id=$1`, [kb.id]);
  await H.pool.query(`UPDATE clients SET recommended_plan='enterprise' WHERE id=$1`, [ke.id]);
  srv = await H.startApp([['/api/tagesplan', require('../routes/tagesplan')]]);
});
test.after(async () => { await srv.close(); });
const adv = () => H.advisorToken();
// nächster Dienstag nach heute (die Pläne dieser Tests hängen nicht vom Wochentag des Testlaufs ab)
const WT = (() => { let d = Z.addTage(Z.heute(), 1); while (Z.wd(d) !== 2 || Z.feiertagName(d)) d = Z.addTage(d, 1); return d; })();
const call = (m, u, body, token = adv()) => srv.call(m, '/api/tagesplan' + u, { token, body });
const neueFreigabe = async (c, label, extra = '') => (await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text) VALUES ($1,$2,$3,'GEHEIMER KLIENTENTEXT') RETURNING id`, [c.id, label, extra || null])).rows[0].id;

test('Rolle: nur die Beraterin, Klienten und Anonyme nicht', async () => {
  assert.equal((await call('GET', '/plan', undefined, H.clientToken(kl.id))).status, 403);
  assert.equal((await call('GET', '/plan', undefined, null)).status, 401);
  assert.equal((await call('POST', '/termine', { titel: 'x' }, H.clientToken(kl.id))).status, 403);
  assert.equal((await call('GET', '/kalender', undefined, H.clientToken(kl.id))).status, 403);
});

test('Plan aus offenen Freigaben, Dauer aus der Zeiterfassung, Link ohne Klienteninhalt im ICS', async () => {
  const r1 = await neueFreigabe(kl, 'E-Mail');
  const alt1 = await neueFreigabe(kl, 'E-Mail'), alt2 = await neueFreigabe(kl, 'E-Mail');
  await H.pool.query(`UPDATE review_requests SET status='approved', minutes=40, time_logged_at=NOW() WHERE id IN ($1,$2)`, [alt1, alt2]);
  await neueFreigabe(ke, 'Rede');
  await neueFreigabe(kb, 'Newsletter', 'themenplan');
  const r = await call('GET', '/plan?datum=' + WT);
  assert.equal(r.status, 200);
  const e = r.body.items.find(i => i.reviewId === r1);
  assert.equal(e.dauer, 40, 'Durchschnitt der erfassten Minuten dieses Klienten und Moduls');
  assert.equal(e.dauerQuelle, 'erfasst');
  const rede = r.body.items.find(i => i.klient === 'Enterprise AG');
  assert.equal(rede.dauer, 20, 'Standard für Texte');
  assert.equal(rede.paket, 'enterprise');
  assert.equal(r.body.items.find(i => i.typ === 'themenplan').dauer, 30);
  const ics = await srv.call('GET', '/api/tagesplan/ics?datum=' + WT, { token: adv(), raw: true });
  const text = await ics.text();
  assert.match(text, /SUMMARY:Team AG\\, E-Mail/);
  assert.doesNotMatch(text, /GEHEIMER KLIENTENTEXT/);
});

test('Dringlich-Knopf wirkt nur auf eigene Freigaben', async () => {
  const id = await neueFreigabe(kl, 'Brief');
  assert.equal((await call('POST', '/dringlich', { reviewId: id, dringlich: true })).status, 200);
  const r = await call('GET', '/plan?datum=' + WT);
  assert.equal(r.body.items.find(i => i.reviewId === id).dringlich, true);
  assert.equal((await call('POST', '/dringlich', { reviewId: 99999 })).status, 404);
  assert.equal((await call('POST', '/dringlich', { reviewId: 'x' })).status, 400);
});

test('Termine anlegen, ändern, löschen; Plan weicht aus', async () => {
  const bad = await call('POST', '/termine', { titel: 'x', datum: Z.heute(), beginn: '10:00', ende: '09:00' });
  assert.equal(bad.status, 400);
  const c = await call('POST', '/termine', { titel: 'Sportkurs', typ: 'sport', datum: Z.heute(), beginn: '08:00', ende: '12:00', wiederholung: 'woechentlich', wochentage: [Z.wd(Z.heute())] });
  assert.equal(c.status, 201);
  const p = await call('POST', '/plan/neu', {});
  assert.ok(p.body.bloecke.some(b => b.titel === 'Sportkurs'));
  for (const i of p.body.items) assert.ok(i.ende <= 480 || i.beginn >= 720 || !p.body.arbeitstag);
  const u = await call('PUT', '/termine/' + c.body.id, { titel: 'Sport', typ: 'sport', datum: Z.heute(), beginn: '17:00', ende: '18:00' });
  assert.equal(u.body.wiederholung, 'keine');
  assert.equal((await call('DELETE', '/termine/' + c.body.id)).status, 200);
  assert.equal((await call('DELETE', '/termine/' + c.body.id)).status, 404);
});

test('Position verschieben und freigeben', async () => {
  const id = await neueFreigabe(kl, 'Position');
  assert.equal((await call('PUT', '/position/r' + id, { datum: WT, beginn: '15:30' })).status, 200);
  const p = (await call('GET', '/plan?datum=' + WT)).body;
  const i = p.items.find(x => x.key === 'r' + id);
  assert.equal(i.start, '15:30'); assert.equal(i.fixiert, true);
  assert.equal((await call('PUT', '/position/r' + id, { datum: 'quatsch', beginn: '15:30' })).status, 400);
  await call('DELETE', '/position/r' + id);
  assert.equal((await call('GET', '/plan?datum=' + WT)).body.items.find(x => x.key === 'r' + id).fixiert, false);
});

test('Einstellungen: Standarddauer und Typfarben', async () => {
  const r = await call('PUT', '/einstellungen', { dauer: { freigabe: 25, anfrage: 99999 }, mittag_von: 690, mittag_bis: 750, typen: [{ key: 'sport', name: 'Sport', farbe: '#112233' }, { key: 'yoga', name: 'Yoga', farbe: 'rot' }, { key: 'lesen', name: 'Lesen', farbe: '#445566' }] });
  assert.equal(r.body.einstellungen.dauer.freigabe, 25);
  assert.equal(r.body.einstellungen.dauer.anfrage, 15, 'ungültig bleibt Standard');
  assert.equal(r.body.einstellungen.mittag_von, 690);
  assert.equal(r.body.typen.find(t => t.key === 'sport').farbe, '#112233');
  assert.ok(r.body.typen.find(t => t.key === 'lesen'));
  assert.ok(!r.body.typen.find(t => t.key === 'yoga'));
  await call('PUT', '/einstellungen', {});
});

test('Kalender-Abo: Token nur als Hash, Feed, Widerruf', async () => {
  const D = require('../lib/tagesplanDaten');
  assert.equal((await call('GET', '/kalender')).body.aktiv, false);
  const c = await call('POST', '/kalender', {});
  assert.match(c.body.webcal, /^webcal:\/\/.+\/api\/tagesplan\/feed\/[A-Za-z0-9_-]{40,}\.ics$/);
  const token = c.body.https.split('/feed/')[1].replace('.ics', '');
  const row = (await H.pool.query('SELECT token_hash FROM tagesplan_token')).rows[0];
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, D.hashVon(token));
  assert.ok(!JSON.stringify((await H.pool.query('SELECT * FROM tagesplan_token')).rows).includes(token));
  const feed = await srv.call('GET', `/api/tagesplan/feed/${token}.ics`, { raw: true });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  assert.match(await feed.text(), /BEGIN:VCALENDAR/);
  assert.equal((await srv.call('GET', '/api/tagesplan/feed/' + 'a'.repeat(43) + '.ics', { raw: true })).status, 404);
  const neu = await call('POST', '/kalender', {});
  const token2 = neu.body.https.split('/feed/')[1].replace('.ics', '');
  assert.equal((await srv.call('GET', `/api/tagesplan/feed/${token}.ics`, { raw: true })).status, 404, 'alter Token ungültig');
  assert.equal((await srv.call('GET', `/api/tagesplan/feed/${token2}.ics`, { raw: true })).status, 200);
  await call('DELETE', '/kalender');
  assert.equal((await srv.call('GET', `/api/tagesplan/feed/${token2}.ics`, { raw: true })).status, 404, 'widerrufen');
});

test('Job: Mail mit Anhang, einmal pro Tag, aus per Umgebungsvariable, frei ohne Dringliches', async () => {
  const { runTagesplanJob } = require('../jobs/tagesplan');
  await H.pool.query(`DELETE FROM tagesplan_versand`);
  H.brevoMails.length = 0;
  const jetzt = Z.zuDate(Z.heute(), 7 * 60);
  const r1 = await runTagesplanJob({ jetzt });
  if (r1.status === 'gesendet') {
    assert.ok(H.brevoMails.length >= 1);
    const m = H.brevoMails[0];
    assert.match(m.subject, /^Tagesplan \w+, \d+\. \w+$/);
    assert.equal(m.attachments[0].name, 'tagesplan.ics');
    assert.match(Buffer.from(m.attachments[0].contentBase64, 'base64').toString(), /BEGIN:VCALENDAR/);
    assert.doesNotMatch(m.text, /[–—]/);
    const n = H.brevoMails.length;
    assert.equal((await runTagesplanJob({ jetzt })).status, 'schon gesendet');
    assert.equal(H.brevoMails.length, n, 'kein zweiter Versand');
  } else assert.equal(r1.status, 'leer');
  process.env.TAGESPLAN = 'aus';
  assert.equal((await runTagesplanJob({ jetzt, datum: '2026-10-14' })).status, 'aus');
  delete process.env.TAGESPLAN;
});

test('Job: Wochenende ohne Dringliches schickt nichts, mit Enterprise schon', async () => {
  const { runTagesplanJob } = require('../jobs/tagesplan');
  await H.pool.query(`DELETE FROM review_requests`);
  await H.pool.query(`DELETE FROM tagesplan_versand`);
  H.brevoMails.length = 0;
  await neueFreigabe(kl, 'Brief');
  const sa = Z.heute(new Date('2026-10-17T12:00:00Z'));
  assert.equal((await runTagesplanJob({ datum: sa, jetzt: Z.zuDate(sa, 420) })).status, 'leer');
  assert.equal(H.brevoMails.length, 0);
  await neueFreigabe(ke, 'Rede');
  assert.equal((await runTagesplanJob({ datum: sa, jetzt: Z.zuDate(sa, 420) })).status, 'gesendet');
  assert.ok(H.brevoMails.length >= 1);
});

// ── Assistent-Aktionen ──
const heute = DI;
const akt = (o) => A.pruefeAktion(JSON.stringify(o), [], { settings: S, heute });
test('Assistent: Sport morgen 17 bis 18 Uhr', () => {
  const a = akt({ aktion: 'termin_anlegen', titel: 'Sport', typ: 'sport', datum: 'morgen', beginn: '17:00', ende: '18:00' });
  assert.equal(a.type, 'termin_anlegen');
  assert.equal(a.bestaetigen, true);
  assert.deepEqual([a.termin.datum, a.termin.beginn, a.termin.ende], ['2026-10-14', '17:00', '18:00']);
  assert.match(a.text, /Stimmt das\?$/);
  assert.doesNotMatch(a.text, /[–—]/);
});
test('Assistent: Sportkurs jeden Dienstag 18 Uhr', () => {
  const a = akt({ aktion: 'termin_anlegen', titel: 'Sportkurs', typ: 'sport', wiederholung: 'woechentlich', wochentage: ['dienstag'], beginn: '18:00' });
  assert.equal(a.termin.wiederholung, 'woechentlich');
  assert.deepEqual(a.termin.wochentage, [2]);
  assert.equal(a.termin.datum, '2026-10-13', 'heute ist Dienstag, erstes Vorkommen heute');
  assert.equal(a.termin.ende, '19:00');
});
test('Assistent: Ferien vom 12. bis 19. Oktober', () => {
  const a = akt({ aktion: 'ferien_anlegen', von: '2026-10-14', bis: '2026-10-19' });
  assert.equal(a.type, 'ferien_anlegen');
  assert.equal(a.termin.typ, 'ferien');
  assert.equal(a.termin.ganztaegig, true);
  assert.equal(a.termin.bis, '2026-10-19');
});
test('Assistent: Nachfrage bei Unklarheit', () => {
  for (const o of [{ aktion: 'termin_anlegen', titel: 'Zahnarzt', datum: 'morgen' }, { aktion: 'termin_anlegen', titel: 'Zahnarzt', beginn: '10:00' },
    { aktion: 'termin_anlegen', titel: 'Z', datum: '2026-02-30', beginn: '10:00' }, { aktion: 'termin_anlegen', titel: 'Z', datum: '2026-10-01', beginn: '10:00' },
    { aktion: 'termin_anlegen', titel: 'Z', datum: 'morgen', beginn: '18:00', ende: '17:00' }, { aktion: 'termin_anlegen', datum: 'morgen', beginn: '10:00' },
    { aktion: 'termin_anlegen', titel: 'Z', datum: 'morgen', beginn: '99:00' }, { aktion: 'ferien_anlegen', von: '2026-10-19', bis: '2026-10-12' },
    { aktion: 'ferien_anlegen' }, { aktion: 'naechste_aufgabe', minuten: 'viel' }]) {
    const a = akt(o);
    assert.equal(a.type, 'answer', JSON.stringify(o));
    assert.ok(a.rueckfrage, JSON.stringify(o));
  }
});
test('Assistent: Plan, neu, nächste Aufgabe', () => {
  assert.equal(akt({ aktion: 'plan_zeigen' }).datum, heute);
  assert.equal(akt({ aktion: 'plan_zeigen', datum: 'morgen' }).datum, '2026-10-14');
  assert.equal(akt({ aktion: 'plan_neu' }).type, 'plan_neu');
  assert.deepEqual(akt({ aktion: 'naechste_aufgabe', minuten: 120 }), { type: 'naechste_aufgabe', minuten: 120 });
  assert.equal(akt({ aktion: 'naechste_aufgabe' }).type, 'naechste_aufgabe');
  assert.ok(A.AKTIONEN.includes('termin_anlegen'));
  assert.ok(AP.PLAN_AKTIONEN.every(x => A.AKTIONEN.includes(x)));
});
test('Assistent: Systemtext nennt Datum und neue Aktionen', () => {
  const s = A.baueSystem('Hilfe', new Date('2026-10-13T08:00:00Z'));
  assert.match(s, /Heute ist Dienstag, 13\. Oktober 2026/);
  assert.match(s, /termin_anlegen/);
});
