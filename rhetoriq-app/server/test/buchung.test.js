// Terminbuchung: öffentliche Routen, Missbrauchsschutz, Doppelbuchung, Mails und Kalenderdatei (gemockt), Token, Erinnerung, Schalter, Formular-Bestätigung.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

// Sync-Schicht beobachten statt Google anzusprechen
const syncLog = [];
{
  const p = require.resolve('../lib/kalendersync');
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: { push: async (e) => { syncLog.push(['push', e]); }, delete: async (e) => { syncLog.push(['delete', e]); } } };
}
const Z = require('../lib/zeit');
const B = require('../lib/buchung');
const BD = require('../lib/buchungDaten');
const { lies } = require('../lib/icsLesen');

const ORIGIN = 'https://rhetoriq.ch';
let offset = 0;
const jetzt = () => new Date(Date.now() + offset);
let srv, srvLimit, srvEmail;

test.before(async () => {
  process.env.ADVISOR_EMAIL = 'contact@lorenalienhard.ch';
  delete process.env.ADVISOR_NOTIFY_EMAIL_2;
  await H.setupBase();
  const route = require('../routes/buchung');
  const inq = require('../routes/inquiries');
  await inq.ensureTable();
  await BD.ensureSchema();
  srv = await H.startApp([['/api/buchung', route.build({ ipMax: 1000, emailMax: 1000, slotMax: 100000, verwaltenMax: 1000, jetzt })], ['/api/inquiry', inq.publicRouter]]);
  srvLimit = await H.startApp([['/api/buchung', route.build({ ipMax: 3, emailMax: 1000, jetzt })]]);
  srvEmail = await H.startApp([['/api/buchung', route.build({ ipMax: 1000, emailMax: 2, jetzt })]]);
});
test.after(async () => { await srv.close(); await srvLimit.close(); await srvEmail.close(); });

const kinds = (k) => H.mails.filter(m => m.kind === k);
const wait = () => new Promise(r => setTimeout(r, 40));
async function post(s, url, body, { origin = ORIGIN, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(s.base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function slots(s = srv) {
  const r = await fetch(s.base + '/api/buchung/slots');
  return { status: r.status, body: await r.json() };
}
// Schickt die Buchung mit einem gültigen Ticket, das 10 Sekunden alt ist
async function buche(felder, { s = srv, ticket } = {}) {
  return post(s, '/api/buchung', { name: 'Anna Muster', email: 'anna@firma.ch', message: 'Ich möchte über meine Stimme sprechen.', einwilligung: true, ticket: ticket || B.ticketNeu(new Date(Date.now() - 10000)), ...felder });
}
const alleZeiten = (sl) => sl.body.tage.flatMap(t => t.zeiten.map(z => ({ ...z, datum: t.datum })));
const aid = 1;
async function einschalten(extra = {}) {
  const r = await fetch(srv.base + '/api/buchung/admin/einstellungen', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + H.advisorToken() }, body: JSON.stringify({ aktiv: true, ...extra }) });
  return r.json();
}
const ausschalten = async () => fetch(srv.base + '/api/buchung/admin/einstellungen', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + H.advisorToken() }, body: JSON.stringify({ aktiv: false }) });
async function aufraeumen() {
  await pool.query('DELETE FROM buchungen');
  await pool.query('DELETE FROM tagesplan_eintraege');
  await pool.query('DELETE FROM inquiries');
  H.mails.length = 0; syncLog.length = 0; BD.cacheLeeren();
}
const entpacke = (ics) => ics.replace(/\r\n[ \t]/g, '');
const tokenAusMail = (m) => /#t=([A-Za-z0-9_-]{43})/.exec(m.text)[1];

test('Schalter AUS (Standard): Landingpage erhält keine Zeiten, Buchung wird abgelehnt', async () => {
  const sl = await slots();
  assert.equal(sl.status, 200);
  assert.equal(sl.body.aktiv, false);
  assert.deepEqual(sl.body.tage, []);
  const r = await buche({ start: new Date(Date.now() + 3 * 86400000).toISOString() });
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buchungen')).rows[0].n, 0);
});

test('Einstellungen nur für die Beraterin', async () => {
  const r = await fetch(srv.base + '/api/buchung/admin/einstellungen');
  assert.equal(r.status, 401);
  const e = await einschalten();
  assert.equal(e.einstellungen.aktiv, true);
  assert.equal(e.link, 'https://rhetoriq.ch/termin');
  const g = await (await fetch(srv.base + '/api/buchung/admin/einstellungen', { headers: { Authorization: 'Bearer ' + H.advisorToken() } })).json();
  assert.equal(g.einstellungen.dauer, 20);
  assert.deepEqual(g.kommende, []);
});

test('Freie Zeiten: gruppiert nach Tag, nur Zeitpunkte, Ticket, nie am Wochenende', async () => {
  const sl = await slots();
  assert.equal(sl.body.aktiv, true);
  assert.equal(sl.body.zeitzone, 'Europe/Zurich');
  assert.ok(sl.body.tage.length >= 5);
  assert.ok(sl.body.ticket);
  for (const t of sl.body.tage) {
    assert.deepEqual(Object.keys(t).sort(), ['datum', 'kurz', 'label', 'zeiten']);
    assert.ok(Z.wd(t.datum) <= 5);
    for (const z of t.zeiten) assert.deepEqual(Object.keys(z).sort(), ['start', 'zeit']);
  }
});

test('Buchung: Eintrag im Tagesplan, Anfrage, Sync, Bestätigung mit Kalenderdatei, Hinweis an die Beraterin', async () => {
  await aufraeumen();
  await einschalten({ kontakt_text: 'Ich rufe Sie an; bitte, halten Sie Ihre Unterlagen bereit.', kontakt_link: 'https://meet.example.ch/lorena' });
  const sl = await slots();
  const z = alleZeiten(sl)[0];
  const r = await buche({ start: z.start, name: 'Anna Muster', email: 'Anna@Firma.ch', message: 'Zeile 1\nZeile 2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true); assert.equal(r.body.zeit, z.zeit); assert.equal(r.body.datum, z.datum); assert.equal(r.body.dauer, 20);
  await wait();

  const b = (await pool.query('SELECT * FROM buchungen')).rows;
  assert.equal(b.length, 1);
  assert.equal(b[0].email, 'anna@firma.ch'); assert.equal(b[0].status, 'gebucht');
  assert.ok(!('token' in b[0]) && !/^[A-Za-z0-9_-]{43}$/.test(b[0].token_hash), 'nur der Hash liegt in der Datenbank');

  const eintr = (await pool.query('SELECT * FROM tagesplan_eintraege')).rows;
  assert.equal(eintr.length, 1);
  assert.equal(eintr[0].typ, 'kunde'); assert.equal(eintr[0].datum, z.datum); assert.equal(eintr[0].titel, 'Gespräch mit Anna Muster');
  assert.equal(eintr[0].ende - eintr[0].beginn, 20);
  assert.ok(syncLog.some(([m, e]) => m === 'push' && e.id === eintr[0].id), 'Google-Sync wurde angestossen');

  const anf = (await pool.query('SELECT * FROM inquiries')).rows;
  assert.equal(anf.length, 1);
  assert.match(anf[0].message, /Terminbuchung/); assert.match(anf[0].message, /Zeile 1/);
  assert.equal(kinds('inquiry_ack').length, 0, 'keine zweite Bestätigung');

  const m = kinds('buchung_bestaetigung');
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'anna@firma.ch');
  assert.match(m[0].text, /^Guten Tag Anna Muster/);
  assert.match(m[0].text, new RegExp(z.zeit.replace(':', ':') + ' bis \\d\\d:\\d\\d Uhr \\(Schweizer Zeit\\)'));
  assert.match(m[0].text, /Dauer: 20 Minuten/);
  assert.match(m[0].text, /Ich rufe Sie an; bitte, halten Sie Ihre Unterlagen bereit\./);
  assert.match(m[0].text, /Videolink: https:\/\/meet\.example\.ch\/lorena/);
  assert.match(m[0].text, /https:\/\/rhetoriq\.ch\/termin#t=[A-Za-z0-9_-]{43}/);
  assert.equal(m[0].senderName, 'Lorena Lienhard');
  assert.ok(!/[–—]/.test(m[0].subject + m[0].text), 'keine Gedankenstriche');
  assert.ok(!/[\r\n]/.test(m[0].subject));
  const att = m[0].attachments[0];
  assert.equal(att.name, 'gespraech.ics');
  const ics = Buffer.from(att.contentBase64, 'base64').toString('utf8');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /TZID:Europe\/Zurich/);
  const hh = z.zeit.replace(':', '');
  assert.ok(ics.includes(`DTSTART;TZID=Europe/Zurich:${z.datum.replace(/-/g, '')}T${hh}00`), 'Beginn in Schweizer Zeit');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, 'Zeile zu lang: ' + l);
  const flach = entpacke(ics);
  assert.ok(flach.includes('Ich rufe Sie an\\; bitte\\, halten Sie Ihre Unterlagen bereit.'), 'Semikolon und Komma maskiert');
  assert.ok(flach.includes('UID:rq-buchung-'));
  assert.ok(lies(ics).length === 1, 'die Datei lässt sich wieder lesen');

  const h = kinds('buchung_hinweis');
  assert.equal(h.length, 1);
  assert.equal(h[0].to, 'contact@lorenalienhard.ch');
  assert.match(h[0].text, /Anna Muster/); assert.match(h[0].text, /anna@firma\.ch/); assert.match(h[0].text, /Zeile 1\nZeile 2/);

  // die Zeit ist weg, Nachbarzeiten innerhalb des Puffers ebenfalls
  const nach = alleZeiten(await slots());
  assert.ok(!nach.some(x => x.start === z.start));
});

test('Keine Doppelbuchung bei gleichzeitigen Anfragen, auch nicht für Zeiten im Puffer', async () => {
  await aufraeumen();
  const sl = await slots();
  const tag = sl.body.tage[1];
  const [a, b] = [tag.zeiten[0], tag.zeiten[1]]; // zum Beispiel 09:00 und 09:30, liegen im Puffer zueinander
  const nameN = (i) => ({ name: 'Person ' + i, email: `p${i}@firma.ch` });
  const rs = await Promise.all([
    buche({ start: a.start, ...nameN(1) }), buche({ start: a.start, ...nameN(2) }), buche({ start: b.start, ...nameN(3) }), buche({ start: a.start, ...nameN(4) })
  ]);
  const ok = rs.filter(r => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(rs.map(r => [r.status, r.body && r.body.error])));
  for (const r of rs.filter(r => r.status !== 200)) {
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'Dieser Termin ist leider gerade vergeben, bitte wählen Sie einen anderen.');
  }
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE status='gebucht'`)).rows[0].n, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM tagesplan_eintraege')).rows[0].n, 1);
});

test('Letzte Sicherung: ein bereits belegter Schlüssel in der Datenbank verhindert die Doppelbuchung auch ohne Kalendereintrag', async () => {
  await aufraeumen();
  const z = alleZeiten(await slots())[4];
  await pool.query(`INSERT INTO buchungen (advisor_id, name, email, start_at, ende_at, datum, beginn, ende, status, slot_key) VALUES (1,'x','x@x.ch',$1,$1,$2,540,560,'gebucht',$3)`, [new Date(z.start), z.datum, `1|${new Date(z.start).toISOString()}`]);
  const r = await buche({ start: z.start });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Dieser Termin ist leider gerade vergeben, bitte wählen Sie einen anderen.');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM tagesplan_eintraege')).rows[0].n, 0);
});

test('Falsche Zeitpunkte werden abgelehnt', async () => {
  await aufraeumen();
  const sl = await slots();
  const z = sl.body.tage[0].zeiten[0];
  const t = Date.parse(z.start);
  const wochenende = Z.zuDate('2026-10-17', 600).toISOString();
  for (const start of [new Date(t + 60000).toISOString(), new Date(t + 10 * 60000).toISOString(), wochenende, '2020-01-01T08:00:00.000Z', 'morgen', '', 'x'.repeat(100), '2026-12-25T08:00:00.000Z', new Date(Date.now() + 40 * 86400000).toISOString()]) {
    const r = await buche({ start });
    assert.ok([400, 409].includes(r.status), `${start}: ${r.status}`);
    assert.notEqual(r.status, 200);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buchungen')).rows[0].n, 0);
});

test('Missbrauchsschutz: Einwilligung, Honeypot, Zeitfenster, Ticket, Herkunft, Felder', async () => {
  await aufraeumen();
  const sl = await slots();
  const start = alleZeiten(sl)[2].start;
  assert.equal((await buche({ start, einwilligung: false })).status, 400);
  assert.equal((await buche({ start, einwilligung: undefined })).status, 400);
  const e = await buche({ start, einwilligung: false });
  assert.match(e.body.error, /Datenschutz/);
  // Honeypot: scheinbarer Erfolg, aber nichts gespeichert und keine Mail
  const hp = await buche({ start, website2: 'http://spam.example' });
  assert.equal(hp.status, 200); assert.equal(hp.body.ok, true);
  // zu schnell: Ticket ist gerade erst ausgestellt
  const frisch = await post(srv, '/api/buchung', { name: 'Anna Muster', email: 'a@firma.ch', einwilligung: true, start, ticket: sl.body.ticket });
  assert.equal(frisch.status, 429);
  // ohne und mit gefälschtem Ticket
  assert.equal((await post(srv, '/api/buchung', { name: 'Anna Muster', email: 'a@firma.ch', einwilligung: true, start })).status, 400);
  assert.equal((await buche({ start }, { ticket: '1760000000000.' + 'A'.repeat(32) })).status, 400);
  // zu altes Ticket
  const alt = B.ticketNeu(new Date(Date.now() - 7 * 3600000));
  assert.equal((await buche({ start }, { ticket: alt })).status, 400);
  // fremde Herkunft
  const tk = B.ticketNeu(new Date(Date.now() - 10000));
  assert.equal((await post(srv, '/api/buchung', { name: 'Anna Muster', email: 'a@firma.ch', einwilligung: true, start, ticket: tk }, { origin: 'https://boese.example' })).status, 401);
  assert.equal((await post(srv, '/api/buchung', { name: 'Anna Muster', email: 'a@firma.ch', einwilligung: true, start, ticket: tk }, { origin: null })).status, 401);
  // Felder
  for (const f of [{ name: '' }, { name: 'A' }, { name: 'x'.repeat(200) }, { name: 'Bob www.spam.ch' }, { email: 'kaputt' }, { email: 'a@b.ch\r\nBcc: x@y.ch' }, { email: 'x'.repeat(130) + '@a.ch' },
    { message: 'x'.repeat(3500) }, { name: { a: 1 } }, { email: ['a@b.ch'] }, { start: 12345 }]) {
    const r = await buche({ start, ...f });
    assert.equal(r.status, 400, JSON.stringify(f).slice(0, 60) + ' -> ' + r.status);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM buchungen')).rows[0].n, 0);
  await wait();
  assert.equal(H.mails.length, 0);
});

test('Höchstens zwei offene Buchungen je E-Mail, höchstens zwölf pro Tag', async () => {
  await aufraeumen();
  const zs = alleZeiten(await slots());
  const wahl = [zs[0], zs[4], zs[8], zs[12]];
  assert.equal((await buche({ start: wahl[0].start })).status, 200);
  assert.equal((await buche({ start: wahl[1].start })).status, 200);
  const dritte = await buche({ start: wahl[2].start });
  assert.equal(dritte.status, 429);
  assert.match(dritte.body.error, /zwei offene Termine/);
  // andere Adresse ist möglich, bis das Tageslimit erreicht ist
  for (let i = 0; i < BD.TAGESLIMIT - 2; i++) {
    await pool.query(`INSERT INTO buchungen (advisor_id, name, email, start_at, ende_at, datum, beginn, ende, status) VALUES (1,'x','l${i}@x.ch',$1,$1,'2026-01-01',540,560,'abgesagt')`, [new Date()]);
  }
  const limit = await buche({ start: wahl[2].start, email: 'neu@firma.ch' });
  assert.equal(limit.status, 429);
  assert.match(limit.body.error, /keine weiteren Buchungen/);
});

test('Ratenbegrenzung pro IP und pro E-Mail', async () => {
  await aufraeumen();
  await pool.query('DELETE FROM buchungen');
  const sl = await slots(srvLimit);
  const start = alleZeiten(sl)[0].start;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await buche({ start, email: `ip${i}@firma.ch`, name: 'Person ' + i }, { s: srvLimit })).status);
  assert.equal(codes.filter(c => c === 429).length, 2, codes.join(','));
  assert.equal(codes[3], 429); assert.equal(codes[4], 429);

  const sl2 = await slots(srvEmail);
  const c2 = [];
  for (let i = 0; i < 4; i++) c2.push((await buche({ start: '2020-01-01T00:00:00.000Z', email: 'viele@firma.ch' }, { s: srvEmail })).status);
  assert.deepEqual(c2, [409, 409, 429, 429], 'auch fehlgeschlagene Versuche zählen');
});

test('Eingaben in Mails: Zeilenumbrüche, Links und Kopfzeilen-Injektion', async () => {
  await aufraeumen();
  const start = alleZeiten(await slots())[3].start;
  const r = await buche({ start, name: 'Anna\r\nBcc: evil\r\nMuster', message: 'Hallo\r\nSubject: Betrug\r\n\r\nEND:VEVENT\u0000' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await buche({ start, name: 'Anna\r\nBcc: evil@x.ch' })).status, 400, 'Adressen im Namen werden abgelehnt');
  await wait();
  for (const m of H.mails) {
    assert.ok(!/[\r\n]/.test(m.subject), 'Betreff: ' + m.subject);
    assert.ok(!/[\r\n]/.test(m.to) && /^[^\s@]+@[^\s@]+$/.test(m.to), 'Empfänger: ' + m.to);
  }
  const best = kinds('buchung_bestaetigung')[0];
  assert.match(best.text, /^Guten Tag Anna Bcc: evil Muster\n/);
  assert.ok(!/\nBcc:/.test(best.text), 'der Name bleibt in einer Zeile');
  const row = (await pool.query('SELECT name FROM buchungen')).rows[0];
  assert.ok(!/[\r\n]/.test(row.name));
  const ent = (await pool.query('SELECT titel, notiz FROM tagesplan_eintraege')).rows[0];
  assert.ok(!/[\r\n]/.test(ent.titel + ent.notiz));
  const ics = Buffer.from(best.attachments[0].contentBase64, 'base64').toString('utf8');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'keine eingeschleusten Ereignisse');
  assert.equal(entpacke(ics).includes('Betrug'), false);
});

test('Absagen mit Token: gibt den Termin frei, löscht im Kalender, Mails an beide, idempotent, falscher Token', async () => {
  await aufraeumen();
  const start = alleZeiten(await slots())[1].start;
  const r = await buche({ start });
  assert.equal(r.status, 200);
  await wait();
  const token = tokenAusMail(kinds('buchung_bestaetigung')[0]);
  const eintragId = (await pool.query('SELECT id FROM tagesplan_eintraege')).rows[0].id;

  const info = await post(srv, '/api/buchung/info', { token });
  assert.equal(info.status, 200); assert.equal(info.body.status, 'gebucht'); assert.equal(info.body.aenderbar, true);
  assert.deepEqual(Object.keys(info.body).sort(), ['aenderbar', 'datum', 'dauer', 'ende', 'label', 'status', 'zeit']);
  assert.equal((await post(srv, '/api/buchung/info', { token: 'falsch' })).status, 404);
  assert.equal((await post(srv, '/api/buchung/info', { token: 'A'.repeat(43) })).status, 404);
  assert.equal((await post(srv, '/api/buchung/absagen', { token: 'A'.repeat(43) })).status, 404);
  assert.equal((await post(srv, '/api/buchung/absagen', { token: ['x'] })).status, 404);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE status='gebucht'`)).rows[0].n, 1, 'falscher Token ändert nichts');

  H.mails.length = 0; syncLog.length = 0;
  const a = await post(srv, '/api/buchung/absagen', { token });
  assert.equal(a.status, 200); assert.equal(a.body.ok, true);
  await wait();
  assert.equal((await pool.query(`SELECT status FROM buchungen`)).rows[0].status, 'abgesagt');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM tagesplan_eintraege')).rows[0].n, 0);
  assert.ok(syncLog.some(([m, e]) => m === 'delete' && e.id === eintragId));
  assert.ok(alleZeiten(await slots()).some(x => x.start === start), 'Zeit ist wieder frei');
  const ab = kinds('buchung_abgesagt'), abB = kinds('buchung_abgesagt_hinweis');
  assert.equal(ab.length, 1); assert.equal(abB.length, 1);
  assert.equal(ab[0].to, 'anna@firma.ch'); assert.equal(abB[0].to, 'contact@lorenalienhard.ch');
  const cancelIcs = Buffer.from(ab[0].attachments[0].contentBase64, 'base64').toString('utf8');
  assert.match(cancelIcs, /METHOD:CANCEL/); assert.match(cancelIcs, /STATUS:CANCELLED/);
  assert.match((await pool.query('SELECT message FROM inquiries')).rows[0].message, /abgesagt/);
  // zweiter Aufruf ändert nichts und sendet nichts
  H.mails.length = 0;
  const a2 = await post(srv, '/api/buchung/absagen', { token });
  assert.equal(a2.status, 200); assert.equal(a2.body.schon, true);
  await wait();
  assert.equal(H.mails.length, 0);
  const info2 = await post(srv, '/api/buchung/info', { token });
  assert.equal(info2.body.status, 'abgesagt'); assert.equal(info2.body.aenderbar, false);
  // eine abgesagte Buchung lässt sich nicht verschieben
  const mv = await buche({ start: alleZeiten(await slots())[5].start, token });
  assert.equal(mv.status, 404);
});

test('Verschieben mit demselben Token: neue Zeit, alter Eintrag weg, Token gilt weiter, vergebene Zeit lässt den Termin stehen', async () => {
  await aufraeumen();
  const zs = alleZeiten(await slots());
  const r1 = await buche({ start: zs[0].start });
  assert.equal(r1.status, 200);
  await wait();
  const token = tokenAusMail(kinds('buchung_bestaetigung')[0]);
  // eine andere Person belegt eine Zeit
  const belegt = zs[10];
  assert.equal((await buche({ start: belegt.start, email: 'andere@firma.ch', name: 'Bernd Beispiel' })).status, 200);
  H.mails.length = 0; syncLog.length = 0;
  const bad = await buche({ start: belegt.start, token });
  assert.equal(bad.status, 409);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE email='anna@firma.ch' AND status='gebucht'`)).rows[0].n, 1, 'alter Termin bleibt');

  const ziel = zs[6];
  const mv = await buche({ start: ziel.start, token, einwilligung: undefined, name: undefined, email: undefined });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.verschoben, true); assert.equal(mv.body.zeit, ziel.zeit);
  await wait();
  const rows = (await pool.query(`SELECT * FROM buchungen WHERE email='anna@firma.ch' ORDER BY id`)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'verschoben'); assert.equal(rows[0].slot_key, null);
  assert.equal(rows[1].status, 'gebucht');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM tagesplan_eintraege WHERE titel LIKE '%Anna%'`)).rows[0].n, 1);
  assert.ok(syncLog.some(([m]) => m === 'delete') && syncLog.some(([m]) => m === 'push'));
  const mm = kinds('buchung_verschoben');
  assert.equal(mm.length, 1); assert.equal(mm[0].to, 'anna@firma.ch');
  assert.match(mm[0].subject, /verschoben/);
  const ics = Buffer.from(mm[0].attachments[0].contentBase64, 'base64').toString('utf8');
  assert.match(ics, /SEQUENCE:1/, 'gleiche Kennung, höhere Version');
  assert.equal(kinds('buchung_verschoben_hinweis').length, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM inquiries')).rows[0].n, 2, 'keine zweite Anfrage für dieselbe Person');
  // derselbe Token gilt für den neuen Termin
  const info = await post(srv, '/api/buchung/info', { token });
  assert.equal(info.body.zeit, ziel.zeit);
  const ab = await post(srv, '/api/buchung/absagen', { token });
  assert.equal(ab.status, 200);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE email='anna@firma.ch' AND status='gebucht'`)).rows[0].n, 0);
  // falscher Token beim Verschieben
  assert.equal((await buche({ start: zs[8].start, token: 'B'.repeat(43) })).status, 404);
  assert.equal((await buche({ start: zs[8].start, token: 'kurz' })).status, 404);
});

test('Beraterin sieht kommende Buchungen und sagt ab', async () => {
  await aufraeumen();
  const zs = alleZeiten(await slots());
  assert.equal((await buche({ start: zs[2].start })).status, 200);
  await wait();
  const liste = await (await fetch(srv.base + '/api/buchung/admin/liste', { headers: { Authorization: 'Bearer ' + H.advisorToken() } })).json();
  assert.equal(liste.kommende.length, 1);
  assert.equal(liste.kommende[0].name, 'Anna Muster');
  assert.equal((await fetch(srv.base + '/api/buchung/admin/liste')).status, 401);
  assert.equal((await fetch(srv.base + '/api/buchung/admin/liste', { headers: { Authorization: 'Bearer ' + H.clientToken(1) } })).status, 403);
  H.mails.length = 0;
  const id = liste.kommende[0].id;
  assert.equal((await post(srv, `/api/buchung/admin/liste/${id}/absagen`, {}, { token: H.advisorToken() })).status, 200);
  await wait();
  const m = kinds('buchung_abgesagt')[0];
  assert.match(m.text, /muss ich unser Gespräch/);
  assert.equal((await post(srv, `/api/buchung/admin/liste/9999/absagen`, {}, { token: H.advisorToken() })).status, 404);
  assert.equal((await post(srv, `/api/buchung/admin/liste/${id}/absagen`, {})).status, 401);
});

test('Erinnerung am Vortag: einmal pro Buchung, nicht für Abgesagte', async () => {
  await aufraeumen();
  const zs = alleZeiten(await slots());
  const a = zs[3], b = zs[9];
  assert.equal((await buche({ start: a.start })).status, 200);
  assert.equal((await buche({ start: b.start, email: 'b@firma.ch', name: 'Bernd Beispiel' })).status, 200);
  await wait();
  const bTok = (await pool.query(`SELECT id FROM buchungen WHERE email='b@firma.ch'`)).rows[0].id;
  await BD.absagen(aid, bTok, { wer: 'beraterin' });
  H.mails.length = 0;
  const vortag = Z.zuDate(Z.addTage(a.datum, -1), 16 * 60);
  const job = require('../jobs/buchung-erinnerung');
  const r1 = await job.runBuchungErinnerungJob({ jetzt: vortag });
  assert.equal(r1.gesendet, 1);
  const r2 = await job.runBuchungErinnerungJob({ jetzt: vortag });
  assert.equal(r2.gesendet, 0, 'idempotent');
  const m = kinds('buchung_erinnerung');
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'anna@firma.ch');
  assert.match(m[0].subject, /Erinnerung/); assert.ok(m[0].text.includes(`um ${a.zeit} Uhr`));
  assert.ok(!/[–—]/.test(m[0].text));
  // andere Tage lösen nichts aus
  assert.equal((await job.runBuchungErinnerungJob({ jetzt: Z.zuDate(Z.addTage(a.datum, -3), 16 * 60) })).gesendet, 0);
  process.env.BUCHUNG_ERINNERUNG = 'aus';
  assert.equal((await job.runBuchungErinnerungJob({ jetzt: vortag })).status, 'aus');
  delete process.env.BUCHUNG_ERINNERUNG;
});

test('Besetzte Zeiten aus Google-Terminen und ICS-Kalendern sperren die Buchung', async () => {
  await aufraeumen();
  const sl = await slots();
  const tag = sl.body.tage[2];
  const KD = require('../lib/kalendersync/daten');
  const q = await KD.quelleAnlegen(aid, 'cal@x', 'Privat', '#123456', false);
  await KD.quelleSetzen(q.id, { aktiv: true });
  await KD.terminSetzen(aid, q.id, { google_id: 'g1', titel: 'Zahnarzt', ganztaegig: false, datum_von: tag.datum, datum_bis: tag.datum, beginn_min: 10 * 60, ende_min: 11 * 60, frei: false });
  const zeile = await KD.fremdAnlegen(aid, 'Outlook', 'x', '#000000');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:o@x', `DTSTART;TZID=Europe/Zurich:${tag.datum.replace(/-/g, '')}T140000`, `DTEND;TZID=Europe/Zurich:${tag.datum.replace(/-/g, '')}T150000`, 'SUMMARY:Intern', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await KD.fremdErgebnis(zeile.id, { ok: true, ereignisse: JSON.stringify(lies(ics)) });
  BD.cacheLeeren();
  const nach = (await slots()).body.tage.find(t => t.datum === tag.datum);
  const zeiten = nach.zeiten.map(z => z.zeit);
  for (const x of ['10:00', '10:30', '09:30', '11:00', '14:00', '14:30', '13:30']) assert.ok(!zeiten.includes(x), x + ' sollte besetzt sein');
  assert.ok(zeiten.includes('09:00') && zeiten.includes('11:30') && zeiten.includes('13:00'), zeiten.join());
  // gebuchte Zeit ist auch bei direkter Anfrage nicht möglich
  assert.equal((await buche({ start: Z.zuDate(tag.datum, 10 * 60).toISOString() })).status, 409);
  assert.equal((await buche({ start: Z.zuDate(tag.datum, 14 * 60).toISOString() })).status, 409);
  await pool.query('DELETE FROM kalender_google_termine'); await pool.query('DELETE FROM kalender_fremd'); BD.cacheLeeren();
});

test('Ausschalten: die Landingpage erhält keine Zeiten mehr, Buchen und Verschieben sind verboten', async () => {
  await aufraeumen();
  await einschalten();
  const start = alleZeiten(await slots())[0].start;
  assert.equal((await buche({ start })).status, 200);
  await wait();
  const token = tokenAusMail(kinds('buchung_bestaetigung')[0]);
  await ausschalten();
  const sl = await slots();
  assert.equal(sl.body.aktiv, false); assert.deepEqual(sl.body.tage, []);
  const neu = await buche({ start: alleZeiten(await (async () => { await einschalten(); const x = await slots(); await ausschalten(); return x; })())[3].start, email: 'x@firma.ch' });
  assert.equal(neu.status, 403);
  assert.equal((await buche({ start, token })).status, 403);
  // Absagen bleibt möglich, damit niemand festhängt
  assert.equal((await post(srv, '/api/buchung/absagen', { token })).status, 200);
  await einschalten();
});

test('Einstellungen wirken: Dauer, Puffer und Arbeitsfenster ändern die Zeiten', async () => {
  await aufraeumen();
  await einschalten({ dauer: 30, puffer: 0, raster: 30, tage: { 1: { an: false }, 2: { an: true, von: 600, bis: 720, pause_von: null, pause_bis: null }, 3: { an: false }, 4: { an: false }, 5: { an: false } } });
  const sl = await slots();
  for (const t of sl.body.tage) {
    assert.equal(Z.wd(t.datum), 2, 'nur Dienstage');
    assert.deepEqual(t.zeiten.map(z => z.zeit), ['10:00', '10:30', '11:00', '11:30']);
  }
  assert.equal(sl.body.dauer, 30);
  const r = await buche({ start: sl.body.tage[0].zeiten[0].start });
  assert.equal(r.body.dauer, 30);
  await einschalten({});
  await aufraeumen();
});

test('Formular ohne Termin: sofortige Bestätigung mit Kopie, eine pro Adresse, nie bei Zeilenumbruch, Anfrage kommt an', async () => {
  await aufraeumen();
  const senden = (body) => post(srv, '/api/inquiry', { elapsed: 5000, ...body });
  const r = await senden({ name: 'Clara Beispiel', email: 'clara@firma.ch', message: 'Ich habe eine Frage zu Ihrem Angebot.' });
  assert.equal(r.status, 200);
  await wait();
  const ack = kinds('inquiry_ack');
  assert.equal(ack.length, 1);
  assert.equal(ack[0].to, 'clara@firma.ch');
  assert.ok(ack[0].text.includes('Danke für Ihre Anfrage. Ich melde mich innert eines Werktags persönlich bei Ihnen.'));
  assert.ok(ack[0].text.includes('clara@firma.ch') && ack[0].text.includes('Ich habe eine Frage zu Ihrem Angebot.'), 'Kopie der Angaben');
  assert.ok(!/[–—]/.test(ack[0].text));
  assert.equal(kinds('inquiry_notify').length, 1, 'die Beraterin erhält die Anfrage weiterhin');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM inquiries')).rows[0].n, 1);
  // gleiche Adresse: keine zweite Bestätigung
  await senden({ name: 'Clara Beispiel', email: 'clara@firma.ch', message: 'Noch etwas.' });
  await wait();
  assert.equal(kinds('inquiry_ack').length, 1);
  assert.equal(kinds('inquiry_notify').length, 2);
  // ungültige Adresse und Zeilenumbruch: abgelehnt, keine Bestätigung
  assert.equal((await senden({ name: 'X Y', email: 'kaputt', message: 'm' })).status, 400);
  assert.equal((await senden({ name: 'X Y', email: 'a@b.ch\r\nBcc: x@y.ch', message: 'm' })).status, 400);
  await wait();
  assert.equal(kinds('inquiry_ack').length, 1);
  assert.ok(H.mails.every(m => !/[\r\n]/.test(m.to) && !/[\r\n]/.test(m.subject)));
  // Bot-Absender mit Honeypot erhält nichts
  await senden({ name: 'Bot', email: 'bot@firma.ch', message: 'x', website2: 'spam' });
  await wait();
  assert.equal(kinds('inquiry_ack').filter(m => m.to === 'bot@firma.ch').length, 0);
});
