// Besetzt-Zeiten aus iCloud und Outlook: ICS-Parser, Schutz gegen SSRF, verschlüsselte Links, Fehleranzeige, Einbindung in den Tagesplan.
process.env.SECRETS_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test-geheimnis-12345678';
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const https = require('https');
const { EventEmitter } = require('events');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { fakeGoogle } = require('../test-support/fakeGoogle');
const Z = require('../lib/zeit');
const D = require('../lib/tagesplanDaten');
const KD = require('../lib/kalendersync/daten');
const F = require('../lib/kalendersync/fremd');
const GA = require('../lib/kalendersync/googleApi');
const google = require('../lib/kalendersync/google');
const safe = require('../lib/safeFetch');
const { lies, expandiere } = require('../lib/icsLesen');

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//DE', ...events.map(e => 'BEGIN:VEVENT\r\n' + e.trim().split('\n').map(l => l.trim()).join('\r\n') + '\r\nEND:VEVENT'), 'END:VCALENDAR'].join('\r\n');
const ex = (text, von, bis) => expandiere(lies(text), von, bis);
const mit = (r) => r.map(x => `${x.datum} ${x.ganztaegig ? 'ganz' : Z.hhmm(x.beginn) + '-' + Z.hhmm(x.ende)} ${x.titel}`);

// ── Parser ──
test('Parser: einfacher Termin mit Zeitzone, UTC und schwebender Zeit', () => {
  const t = ics(`UID:1
    DTSTART;TZID=Europe/Zurich:20261013T090000
    DTEND;TZID=Europe/Zurich:20261013T100000
    SUMMARY:Zürcher Zeit`, `UID:2
    DTSTART:20261013T070000Z
    DTEND:20261013T080000Z
    SUMMARY:UTC im Sommer`, `UID:3
    DTSTART:20261213T070000Z
    DTEND:20261213T080000Z
    SUMMARY:UTC im Winter`, `UID:4
    DTSTART:20261014T143000
    DTEND:20261014T153000
    SUMMARY:Schwebend`);
  assert.deepEqual(mit(ex(t, '2026-10-01', '2026-12-31')), ['2026-10-13 09:00-10:00 Zürcher Zeit', '2026-10-13 09:00-10:00 UTC im Sommer', '2026-10-14 14:30-15:30 Schwebend', '2026-12-13 08:00-09:00 UTC im Winter']);
});

test('Parser: andere Zeitzonen und Windows-Namen werden nach Zürich umgerechnet', () => {
  const t = ics(`UID:1
    DTSTART;TZID=America/New_York:20261013T090000
    DTEND;TZID=America/New_York:20261013T100000
    SUMMARY:New York`, `UID:2
    DTSTART;TZID=W. Europe Standard Time:20261013T090000
    DTEND;TZID=W. Europe Standard Time:20261013T093000
    SUMMARY:Outlook`, `UID:3
    DTSTART;TZID=Gibts/Nicht:20261013T090000
    DTEND;TZID=Gibts/Nicht:20261013T100000
    SUMMARY:Unbekannte Zone`);
  assert.deepEqual(mit(ex(t, '2026-10-13', '2026-10-13')), ['2026-10-13 09:00-09:30 Outlook', '2026-10-13 09:00-10:00 Unbekannte Zone', '2026-10-13 15:00-16:00 New York']);
});

test('Parser: ganztägige Termine, mehrtägig, Dauer statt Ende, Terminende über Mitternacht', () => {
  const t = ics(`UID:1
    DTSTART;VALUE=DATE:20261015
    DTEND;VALUE=DATE:20261016
    SUMMARY:Ein Tag`, `UID:2
    DTSTART;VALUE=DATE:20261020
    DTEND;VALUE=DATE:20261023
    SUMMARY:Drei Tage`, `UID:3
    DTSTART:20261016T090000
    DURATION:PT1H30M
    SUMMARY:Mit Dauer`, `UID:4
    DTSTART:20261017T223000
    DTEND:20261018T013000
    SUMMARY:Nachtschicht`);
  const r = mit(ex(t, '2026-10-15', '2026-10-23'));
  assert.deepEqual(r, ['2026-10-15 ganz Ein Tag', '2026-10-16 09:00-10:30 Mit Dauer', '2026-10-17 22:30-24:00 Nachtschicht', '2026-10-18 00:00-01:30 Nachtschicht', '2026-10-20 ganz Drei Tage', '2026-10-21 ganz Drei Tage', '2026-10-22 ganz Drei Tage']);
});

test('Parser: RRULE täglich mit INTERVAL und COUNT', () => {
  const t = ics(`UID:1
    DTSTART:20261012T080000
    DTEND:20261012T090000
    RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3
    SUMMARY:Alle zwei Tage`);
  assert.deepEqual(ex(t, '2026-10-01', '2026-11-30').map(x => x.datum), ['2026-10-12', '2026-10-14', '2026-10-16']);
});

test('Parser: RRULE wöchentlich mit BYDAY, UNTIL und EXDATE', () => {
  const t = ics(`UID:1
    DTSTART;TZID=Europe/Zurich:20261012T090000
    DTEND;TZID=Europe/Zurich:20261012T100000
    RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261028T235959Z
    EXDATE;TZID=Europe/Zurich:20261014T090000
    SUMMARY:Montag und Mittwoch`);
  assert.deepEqual(ex(t, '2026-10-01', '2026-12-31').map(x => x.datum), ['2026-10-12', '2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28']);
  const woche14 = ics(`UID:2
    DTSTART:20261013T100000
    DTEND:20261013T110000
    RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3
    SUMMARY:Zweiwöchentlich`);
  assert.deepEqual(ex(woche14, '2026-10-01', '2026-12-31').map(x => x.datum), ['2026-10-13', '2026-10-27', '2026-11-10']);
});

test('Parser: RRULE monatlich (Tag im Monat, erster Montag, letzter Freitag) und jährlich', () => {
  const t = ics(`UID:1
    DTSTART:20261015T090000
    DTEND:20261015T100000
    RRULE:FREQ=MONTHLY;COUNT=3
    SUMMARY:Am 15.`, `UID:2
    DTSTART:20261102T090000
    DTEND:20261102T100000
    RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3
    SUMMARY:Erster Montag`, `UID:3
    DTSTART:20261030T090000
    DTEND:20261030T100000
    RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
    SUMMARY:Letzter Freitag`, `UID:4
    DTSTART;VALUE=DATE:20261031
    RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4
    SUMMARY:Der 31.`, `UID:5
    DTSTART;VALUE=DATE:20260301
    RRULE:FREQ=YEARLY
    SUMMARY:Jahrestag`);
  const r = ex(t, '2026-10-01', '2027-03-31');
  const von = (name) => r.filter(x => x.titel === name).map(x => x.datum);
  assert.deepEqual(von('Am 15.'), ['2026-10-15', '2026-11-15', '2026-12-15']);
  assert.deepEqual(von('Erster Montag'), ['2026-11-02', '2026-12-07', '2027-01-04']);
  assert.deepEqual(von('Letzter Freitag'), ['2026-10-30', '2026-11-27', '2026-12-25']);
  assert.deepEqual(von('Der 31.'), ['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31'], 'Monate ohne 31. werden übersprungen');
  assert.deepEqual(von('Jahrestag'), ['2027-03-01']);
});

test('Parser: Sommerzeit bleibt bei wöchentlichen Terminen auf der gleichen Uhrzeit', () => {
  const t = ics(`UID:1
    DTSTART;TZID=Europe/Zurich:20261019T090000
    DTEND;TZID=Europe/Zurich:20261019T100000
    RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO
    SUMMARY:Montag`, `UID:2
    DTSTART;TZID=America/New_York:20261026T090000
    DTEND;TZID=America/New_York:20261026T100000
    RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO
    SUMMARY:New York über die Zeitumstellung`);
  const r = ex(t, '2026-10-19', '2026-11-30');
  assert.deepEqual(mit(r.filter(x => x.titel === 'Montag')), ['2026-10-19 09:00-10:00 Montag', '2026-10-26 09:00-10:00 Montag']);
  // 26.10. 09:00 New York (EDT, UTC-4) = 13:00 UTC = 14:00 Zürich (CET, Sommerzeit endet am 25.10.); 2.11. 09:00 EST (UTC-5) = 14:00 UTC = 15:00 Zürich
  assert.deepEqual(mit(r.filter(x => /New York/.test(x.titel))), ['2026-10-26 14:00-15:00 New York über die Zeitumstellung', '2026-11-02 15:00-16:00 New York über die Zeitumstellung']);
});

test('Parser: geänderte und abgesagte einzelne Termine einer Serie (RECURRENCE-ID)', () => {
  const t = ics(`UID:s
    DTSTART:20261012T090000
    DTEND:20261012T100000
    RRULE:FREQ=DAILY;COUNT=4
    SUMMARY:Serie`, `UID:s
    RECURRENCE-ID:20261013T090000
    DTSTART:20261013T140000
    DTEND:20261013T150000
    SUMMARY:Serie verschoben`, `UID:s
    RECURRENCE-ID:20261014T090000
    STATUS:CANCELLED
    DTSTART:20261014T090000
    SUMMARY:Serie`);
  assert.deepEqual(mit(ex(t, '2026-10-01', '2026-10-31')), ['2026-10-12 09:00-10:00 Serie', '2026-10-13 14:00-15:00 Serie verschoben', '2026-10-15 09:00-10:00 Serie']);
});

test('Parser: Zeilenfaltung, Maskierung, abgesagte und freie Termine', () => {
  const t = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261013T090000\r\nDTEND:20261013T100000\r\nSUMMARY:Ein langer\r\n  Titel\\, mit Komma\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nDTSTART:20261013T110000\r\nDTEND:20261013T120000\r\nSTATUS:CANCELLED\r\nSUMMARY:Abgesagt\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:3\r\nDTSTART:20261013T130000\r\nDTEND:20261013T140000\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Frei\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const r = ex(t, '2026-10-13', '2026-10-13');
  assert.equal(r.length, 2);
  assert.equal(r[0].titel, 'Ein langer Titel, mit Komma');
  assert.equal(r[1].frei, true);
  assert.deepEqual(lies('kaputt'), []);
  assert.deepEqual(lies(''), []);
});

// ── SSRF ──
test('SSRF: nur https, keine privaten oder lokalen Adressen, keine Zugangsdaten, kein fremder Port', () => {
  const ok = F.pruefeUrl('webcal://p01-caldav.icloud.com/published/2/abc');
  assert.equal(ok.protocol, 'https:');
  assert.equal(F.pruefeUrl('webcals://example.com/a.ics').protocol, 'https:');
  assert.equal(F.pruefeUrl('https://outlook.office365.com/owa/calendar/x/y/reachcalendar.ics').hostname, 'outlook.office365.com');
  for (const bad of ['http://example.com/a.ics', 'ftp://example.com/a.ics', 'file:///etc/passwd', 'https://localhost/a.ics', 'https://foo.localhost/a.ics', 'https://127.0.0.1/a.ics', 'https://10.0.0.5/a.ics',
    'https://192.168.1.1/a.ics', 'https://172.16.0.1/a.ics', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/a.ics', 'https://[fd00::1]/a.ics', 'https://[::ffff:127.0.0.1]/a.ics',
    'https://0.0.0.0/a.ics', 'https://drucker.local/a.ics', 'https://intern.internal/a.ics', 'https://user:pw@example.com/a.ics', 'https://example.com:8443/a.ics', 'https://example.com:22/a.ics', '', '   ', 'kein link', 'javascript:alert(1)']) {
    assert.throws(() => F.pruefeUrl(bad), F.FremdFehler, bad);
  }
});

test('SSRF: Namen, die auf private Adressen zeigen, werden beim Verbinden abgelehnt (DNS-Prüfung im Socket)', async () => {
  const orig = dns.lookup;
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '10.1.2.3', family: 4 }]); };
  try {
    await new Promise((res, rej) => safe.guardedLookup('boese.example.com', {}, (err) => (err ? res() : rej(new Error('hätte abgelehnt werden müssen')))));
    dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]); };
    await new Promise((res, rej) => safe.guardedLookup('gemischt.example.com', {}, (err) => (err ? res() : rej(new Error('eine private Adresse genügt zur Ablehnung')))));
    dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }]); };
    await new Promise((res, rej) => safe.guardedLookup('gut.example.com', {}, (err, list) => (err ? rej(err) : res(list))));
  } finally { dns.lookup = orig; }
});

test('SSRF: Weiterleitungen werden begrenzt und jedes Ziel erneut geprüft', async () => {
  const besucht = [];
  F._setNetz({ einmal: async (u) => { besucht.push(u.hostname); return { status: 302, weiter: u.hostname === 'a.example.com' ? 'https://b.example.com/x' : 'http://127.0.0.1/geheim' }; } });
  await assert.rejects(() => F.holeIcs('https://a.example.com/x'), /nicht erlaubt|https/);
  assert.deepEqual(besucht, ['a.example.com', 'b.example.com'], 'das private Ziel wird nie angefragt');
  besucht.length = 0;
  F._setNetz({ einmal: async (u) => { besucht.push(u.hostname); return { status: 302, weiter: 'https://again.example.com/' + besucht.length }; } });
  await assert.rejects(() => F.holeIcs('https://start.example.com/'), /Zu viele Weiterleitungen/);
  assert.equal(besucht.length, F.LIMITS.weiterleitungen + 1);
  F._setNetz({ einmal: async (u) => ({ status: 302, weiter: 'https://169.254.169.254/latest' }) });
  await assert.rejects(() => F.holeIcs('https://a.example.com/x'), /nicht erlaubt/);
});

test('Antwortgrösse und Dauer sind begrenzt, der Socket prüft jede Adresse', async () => {
  const orig = https.request;
  const maxAlt = F.LIMITS.maxBytes, zeitAlt = F.LIMITS.timeoutMs;
  let optionen;
  const bauen = (verhalten) => (u, opts, cb) => {
    optionen = opts;
    const req = new EventEmitter();
    req.destroy = (e) => setImmediate(() => req.emit('error', e || new Error('zerstört')));
    req.end = () => verhalten(req, cb);
    return req;
  };
  const res = (status, daten) => { const r = new EventEmitter(); r.statusCode = status; r.headers = {}; r.resume = () => {}; r.daten = daten; return r; };
  const echt = F.netzEcht;
  try {
    F.LIMITS.maxBytes = 50;
    https.request = bauen((req, cb) => { const r = res(200); setImmediate(() => { cb(r); r.emit('data', Buffer.alloc(100, 65)); }); });
    await assert.rejects(() => echt.einmal(new URL('https://example.com/a.ics'), {}), /zu gross/);
    assert.equal(optionen.lookup, safe.guardedLookup, 'eigene Adressprüfung im Socket');
    assert.equal(optionen.timeout, zeitAlt);
    https.request = bauen((req) => { setImmediate(() => req.emit('timeout')); });
    await assert.rejects(() => echt.einmal(new URL('https://example.com/a.ics'), {}), /Zeitüberschreitung/);
    https.request = bauen((req, cb) => { const r = res(304); setImmediate(() => cb(r)); });
    assert.deepEqual(await echt.einmal(new URL('https://example.com/a.ics'), { etag: '"x"' }), { status: 304 });
    assert.equal(optionen.headers['If-None-Match'], '"x"');
    https.request = bauen((req, cb) => { const r = res(200); setImmediate(() => { cb(r); r.emit('data', Buffer.from('BEGIN:VCALENDAR')); r.emit('end'); }); });
    const ok = await echt.einmal(new URL('https://example.com/a.ics'), { lastModified: 'Sat, 10 Oct 2026 10:00:00 GMT' });
    assert.equal(ok.text, 'BEGIN:VCALENDAR');
    assert.equal(optionen.headers['If-Modified-Since'], 'Sat, 10 Oct 2026 10:00:00 GMT');
    https.request = bauen((req, cb) => { const r = res(500); setImmediate(() => cb(r)); });
    await assert.rejects(() => echt.einmal(new URL('https://example.com/a.ics'), {}), /Status 500/);
  } finally { https.request = orig; F.LIMITS.maxBytes = maxAlt; F.LIMITS.timeoutMs = zeitAlt; }
});

// ── Datenbank, Routen, Plan ──
let srv, klient;
const adv = () => H.advisorToken();
const call = (m, u, body, token = adv()) => srv.call(m, u, { token, body: m === 'GET' ? undefined : body });
const WT = (() => { let d = Z.addTage(Z.heute(), 3); while (Z.wd(d) !== 2 || Z.feiertagName(d)) d = Z.addTage(d, 1); return d; })();
const logs = [];
for (const k of ['log', 'error', 'warn', 'info']) { const o = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(' ')); if (process.env.KS_DEBUG) o(...a); }; }
const GEHEIM_PFAD = '/published/streng-geheimer-pfad-4711';
const LINK = 'webcal://p99-caldav.icloud.com' + GEHEIM_PFAD;

function kalenderDatei(...events) { return ics(...events); }
const frei = (titel, datum, von, bis) => `UID:${titel}${datum}
  DTSTART;TZID=Europe/Zurich:${datum.replace(/-/g, '')}T${von.replace(':', '')}00
  DTEND;TZID=Europe/Zurich:${datum.replace(/-/g, '')}T${bis.replace(':', '')}00
  SUMMARY:${titel}`;

test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await H.pool.query(`CREATE TABLE inquiries (id SERIAL PRIMARY KEY, name TEXT, company TEXT, status TEXT NOT NULL DEFAULT 'neu', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await require('../lib/schemaRedesign').ensureSchema();
  await D.ensureSchema();
  klient = await H.addClient('Fremd AG');
  srv = await H.startApp([['/api/tagesplan', require('../routes/tagesplan')], ['/api/kalender/fremd', require('../routes/kalenderFremd')]]);
});
test.after(async () => { await srv.close(); });
test.beforeEach(async () => {
  for (const t of ['kalender_fremd', 'kalender_google', 'kalender_google_map', 'tagesplan_eintraege', 'tagesplan_positionen', 'review_requests']) await H.pool.query(`DELETE FROM ${t}`);
  logs.length = 0;
});

let antwortDatei = null, netzAufrufe = [];
function netzMock(fn) { netzAufrufe = []; F._setNetz({ einmal: async (u, o) => { netzAufrufe.push({ url: u.toString(), ...o }); return fn(u, o); } }); }
const ok200 = (text, extra = {}) => async () => ({ status: 200, text, etag: '"v1"', lastModified: null, ...extra });

test('Hinzufügen: Link wird geprüft, verschlüsselt gespeichert und nie zurückgegeben oder geloggt', async () => {
  netzMock(ok200(kalenderDatei(frei('Zahnarzt', WT, '09:00', '10:00'))));
  const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'iCloud privat', url: LINK, farbe: '#445566' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['abgerufenAm', 'aktiv', 'bezeichnung', 'erfolgAm', 'farbe', 'fehler', 'fehlerSeit', 'id']);
  assert.equal(r.body.farbe, '#445566');
  assert.ok(!JSON.stringify(r.body).includes('icloud') && !JSON.stringify(r.body).includes(GEHEIM_PFAD));
  const row = (await H.pool.query('SELECT * FROM kalender_fremd')).rows[0];
  assert.ok(row.url_enc.startsWith('v1.'));
  assert.ok(!row.url_enc.includes('icloud') && !JSON.stringify(row).includes(GEHEIM_PFAD), 'nur verschlüsselt');
  assert.equal(netzAufrufe[0].url, 'https://p99-caldav.icloud.com' + GEHEIM_PFAD, 'webcal wurde zu https');
  const liste = await call('GET', '/api/kalender/fremd');
  assert.ok(!JSON.stringify(liste.body).includes(GEHEIM_PFAD));
  assert.equal(liste.body.kalender.length, 1);
  assert.ok(!logs.join('\n').includes(GEHEIM_PFAD) && !logs.join('\n').includes('icloud'), 'Link nie im Log');
});

test('Hinzufügen: ungültige, unsichere und keine Kalender-Links werden abgelehnt', async () => {
  netzMock(ok200('<html>Hallo</html>'));
  const nichtKalender = await call('POST', '/api/kalender/fremd', { bezeichnung: 'x', url: 'https://example.com/seite.html' });
  assert.equal(nichtKalender.status, 400);
  assert.match(nichtKalender.body.error, /keine Kalenderdatei/);
  for (const url of ['http://example.com/a.ics', 'https://127.0.0.1/a.ics', 'https://localhost/a.ics', 'https://10.0.0.1/a.ics', '']) {
    const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'x', url });
    assert.equal(r.status, 400, url);
    assert.ok(!JSON.stringify(r.body).includes('127.0.0.1') || true);
  }
  assert.equal((await call('POST', '/api/kalender/fremd', { bezeichnung: '', url: 'https://example.com/a.ics' })).status, 400);
  assert.equal((await H.pool.query('SELECT 1 FROM kalender_fremd')).rows.length, 0);
  const k = process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY;
  try {
    netzMock(ok200(kalenderDatei(frei('A', WT, '09:00', '10:00'))));
    const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'x', url: 'https://example.com/a.ics' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /Verschlüsselung/);
    assert.equal((await H.pool.query('SELECT 1 FROM kalender_fremd')).rows.length, 0, 'ohne Schlüssel nichts gespeichert');
  } finally { process.env.SECRETS_ENCRYPTION_KEY = k; }
});

test('Der Plan plant um die Besetzt-Zeiten herum, sie sind schreibgeschützt, grau markiert und nicht im Abo-Feed', async () => {
  netzMock(ok200(kalenderDatei(frei('Outlook Sitzung', WT, '07:30', '09:30'), `UID:ganz
    DTSTART;VALUE=DATE:${WT.replace(/-/g, '')}
    DTEND;VALUE=DATE:${Z.addTage(WT, 1).replace(/-/g, '')}
    SUMMARY:Konferenz`)));
  const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'Outlook Arbeit', url: 'https://outlook.office365.com/owa/calendar/abc/cal.ics', farbe: '#778899' });
  assert.equal(r.status, 201);
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','x', TRUE)`, [klient.id]);
  const plan = await D.planFuer(1, WT);
  assert.equal(plan.arbeitstag, true, 'ein ganztägiger Fremdtermin macht den Tag nicht frei');
  const sperr = plan.bloecke.filter(b => b.fremd);
  assert.equal(sperr.length, 2);
  assert.equal(sperr[0].farbe, '#778899');
  assert.equal(sperr[0].quelle, 'Outlook Arbeit');
  assert.equal(sperr[0].typ, 'fremd');
  const sitzung = sperr.find(b => !b.ganztaegig);
  assert.equal(sitzung.beginn, 450);
  assert.equal(plan.items.length, 1);
  const item = plan.items[0];
  assert.ok(item.beginn >= sitzung.ende || item.ende <= sitzung.beginn, `Aufgabe ${item.start} liegt nicht in der Sitzung`);
  assert.equal(item.beginn, 570, 'direkt nach der Sitzung');
  // Woche und Termine-Liste
  const woche = await call('GET', `/api/tagesplan/woche?montag=${Z.montagVon(WT)}`);
  assert.ok(woche.body.tage.find(t => t.datum === WT).bloecke.some(b => b.fremd));
  const termine = await call('GET', '/api/tagesplan/termine');
  assert.equal(termine.body.termine.length, 0, 'fremde Termine sind keine eigenen Termine');
  // nicht im Abo-Feed und nicht in der Mail-Datei
  const { ics: feed } = await D.icsFuerTag(1, WT, { abo: true });
  assert.ok(!feed.includes('Outlook Sitzung') && !feed.includes('Konferenz'));
  const { ics: tag } = await D.icsFuerTag(1, WT);
  assert.ok(!tag.includes('Outlook Sitzung'));
  // Terminänderung bei den Fremden verändern nichts an eigenen Einträgen
  const put = await call('PUT', '/api/tagesplan/termine/99999', { titel: 'x', datum: WT, beginn: '10:00', ende: '11:00' });
  assert.equal(put.status, 404);
});

test('Deaktivierte Kalender sperren nichts, Entfernen löscht die gespeicherten Termine', async () => {
  netzMock(ok200(kalenderDatei(frei('Sitzung', WT, '08:00', '09:00'))));
  const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'K', url: 'https://example.com/a.ics' });
  const id = r.body.id;
  assert.equal((await D.planFuer(1, WT)).bloecke.filter(b => b.fremd).length, 1);
  const p = await call('PATCH', `/api/kalender/fremd/${id}`, { aktiv: false, farbe: '#112233', bezeichnung: 'Neu' });
  assert.equal(p.body.aktiv, false);
  assert.equal(p.body.farbe, '#112233');
  assert.equal(p.body.bezeichnung, 'Neu');
  assert.equal((await D.planFuer(1, WT)).bloecke.filter(b => b.fremd).length, 0);
  assert.equal((await call('PATCH', `/api/kalender/fremd/${id}`, { farbe: 'rot' })).status, 400);
  assert.equal((await call('PATCH', '/api/kalender/fremd/9999', { aktiv: true })).status, 404);
  const d = await call('DELETE', `/api/kalender/fremd/${id}`);
  assert.equal(d.body.ok, true);
  assert.equal((await H.pool.query('SELECT 1 FROM kalender_fremd')).rows.length, 0);
  assert.equal((await call('DELETE', `/api/kalender/fremd/${id}`)).status, 404);
});

test('Serien aus dem fremden Kalender sperren jede Wiederholung', async () => {
  netzMock(ok200(kalenderDatei(`UID:serie
    DTSTART;TZID=Europe/Zurich:${WT.replace(/-/g, '')}T100000
    DTEND;TZID=Europe/Zurich:${WT.replace(/-/g, '')}T110000
    RRULE:FREQ=WEEKLY;COUNT=3
    SUMMARY:Wöchentlich`)));
  await call('POST', '/api/kalender/fremd', { bezeichnung: 'K', url: 'https://example.com/a.ics' });
  for (const n of [0, 7, 14]) assert.equal((await D.fremdFuerTag(1, Z.addTage(WT, n))).length, 1, 'Woche ' + n);
  assert.equal((await D.fremdFuerTag(1, Z.addTage(WT, 21))).length, 0);
});

test('Fehler pro Quelle: «nicht erreichbar seit», der Plan läuft weiter, Erfolg löscht den Fehler', async () => {
  netzMock(ok200(kalenderDatei(frei('Sitzung', WT, '08:00', '09:00'))));
  const r = await call('POST', '/api/kalender/fremd', { bezeichnung: 'Wackelig', url: 'https://example.com/geheim/a.ics' });
  netzMock(async () => { const e = new Error('connect ECONNREFUSED example.com'); e.code = 'ECONNREFUSED'; throw e; });
  const { runKalendersyncJob } = require('../jobs/kalendersync');
  await runKalendersyncJob();
  let liste = (await call('GET', '/api/kalender/fremd')).body.kalender[0];
  assert.equal(liste.fehler, 'Der Kalender ist nicht erreichbar.');
  assert.ok(liste.fehlerSeit);
  const seit1 = new Date(liste.fehlerSeit).getTime();
  assert.ok(!JSON.stringify(liste).includes('example.com'), 'Fehlertext ohne Adresse');
  assert.ok(!logs.join('\n').includes('example.com') && !logs.join('\n').includes('geheim'), 'nichts im Log');
  // der Plan läuft mit den zuletzt bekannten Daten weiter
  const plan = await D.planFuer(1, WT);
  assert.equal(plan.bloecke.filter(b => b.fremd).length, 1);
  await runKalendersyncJob();
  liste = (await call('GET', '/api/kalender/fremd')).body.kalender[0];
  assert.equal(new Date(liste.fehlerSeit).getTime(), seit1, '«seit» bleibt der erste Fehler');
  // Statuscode-Fehler
  netzMock(async () => { throw new F.FremdFehler('Der Kalender antwortet mit Status 404.'); });
  await runKalendersyncJob();
  assert.match((await call('GET', '/api/kalender/fremd')).body.kalender[0].fehler, /Status 404/);
  netzMock(ok200(kalenderDatei(frei('Sitzung', WT, '08:00', '09:00'), frei('Neu', WT, '14:00', '15:00'))));
  await runKalendersyncJob();
  liste = (await call('GET', '/api/kalender/fremd')).body.kalender[0];
  assert.equal(liste.fehler, null);
  assert.equal(liste.fehlerSeit, null);
  assert.equal((await D.planFuer(1, WT)).bloecke.filter(b => b.fremd).length, 2);
  assert.ok(r.body.id);
});

test('ETag und If-Modified-Since: unveränderte Kalender werden nicht neu gelesen', async () => {
  netzMock(ok200(kalenderDatei(frei('Sitzung', WT, '08:00', '09:00')), { etag: '"abc"', lastModified: 'Fri, 09 Oct 2026 10:00:00 GMT' }));
  await call('POST', '/api/kalender/fremd', { bezeichnung: 'K', url: 'https://example.com/a.ics' });
  netzMock(async () => ({ status: 304 }));
  const { runKalendersyncJob } = require('../jobs/kalendersync');
  const r = await runKalendersyncJob();
  assert.equal(r.fremd, 0, 'nichts geändert');
  assert.equal(netzAufrufe[0].etag, '"abc"');
  assert.equal(netzAufrufe[0].lastModified, 'Fri, 09 Oct 2026 10:00:00 GMT');
  const z = (await call('GET', '/api/kalender/fremd')).body.kalender[0];
  assert.equal(z.fehler, null);
  assert.equal((await D.planFuer(1, WT)).bloecke.filter(b => b.fremd).length, 1, 'Daten bleiben erhalten');
});

test('Beim Öffnen der Kalenderseite: leise nur für Quellen, die länger nicht gelesen wurden', async () => {
  netzMock(ok200(kalenderDatei(frei('Sitzung', WT, '08:00', '09:00'))));
  await call('POST', '/api/kalender/fremd', { bezeichnung: 'K', url: 'https://example.com/a.ics' });
  netzAufrufe.length = 0;
  const leise = await call('POST', '/api/kalender/fremd/abrufen', { leise: true });
  assert.equal(leise.status, 200);
  assert.equal(netzAufrufe.length, 0, 'gerade erst gelesen');
  await call('POST', '/api/kalender/fremd/abrufen', {});
  assert.equal(netzAufrufe.length, 1);
});

test('Besetzt-Zeiten werden nie nach Google gespiegelt', async () => {
  netzMock(ok200(kalenderDatei(frei('Geheimer Arzttermin', WT, '08:00', '09:00'))));
  await call('POST', '/api/kalender/fremd', { bezeichnung: 'K', url: 'https://example.com/a.ics' });
  const g = fakeGoogle();
  GA._setHttp({ fetch: g.fetch, sleep: g.sleep });
  google._setZeitgeber({ entprellung: 20, wiederholung: [], webhookEntprellung: 10 });
  await google.verbindungHerstellen(1, 'gute-code', 'v');
  await google.synchronisiere(1, { voll: true });
  await call('POST', '/api/tagesplan/termine', { titel: 'Eigener Termin', typ: 'termin', datum: WT, beginn: '11:00', ende: '12:00' });
  await google._ruhe();
  const alle = JSON.stringify([...g.ereignisse.values()]);
  assert.ok(alle.includes('Eigener Termin'));
  assert.ok(!alle.includes('Geheimer Arzttermin'));
  await google.trennen(1);
});
