// Warteliste «Platz sichern»: Schalter, echte Zähler, Plätze nie unter 0, Doppeleintrag, Missbrauchsschutz, Mails (gemockt), Einwilligung, Verwaltung nur für die Beraterin.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;
const B = require('../lib/buchung');
const W = require('../lib/warteliste');

const ORIGIN = 'https://rhetoriq.ch';
let srv, srvIp, srvEmail;
let tAdv;

test.before(async () => {
  process.env.ADVISOR_EMAIL = 'contact@lorenalienhard.ch';
  delete process.env.ADVISOR_NOTIFY_EMAIL_2;
  await H.setupBase();
  await W.ensureSchema();
  const route = require('../routes/warteliste');
  srv = await H.startApp([['/api/warteliste', route.build({ ipMax: 1000, emailMax: 1000, statusMax: 100000 })]]);
  srvIp = await H.startApp([['/api/warteliste', route.build({ ipMax: 3, emailMax: 1000 })]]);
  srvEmail = await H.startApp([['/api/warteliste', route.build({ ipMax: 1000, emailMax: 2 })]]);
  tAdv = H.advisorToken();
});
test.after(async () => { await srv.close(); await srvIp.close(); await srvEmail.close(); });

const wait = () => new Promise(r => setTimeout(r, 40));
const kinds = (k) => H.mails.filter(m => m.kind === k);
async function post(s, body, { origin = ORIGIN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const r = await fetch(s.base + '/api/warteliste', { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const eintrag = (felder = {}, s = srv) => post(s, {
  name: 'Anna Muster', email: 'anna@firma.ch', unternehmen: 'Muster AG', branche: 'Versicherung', anliegen: 'Ich möchte unsere Stimme schärfen.', einwilligung: true,
  ticket: B.ticketNeu(new Date(Date.now() - 10000)), ...felder
});
const adm = (method, url, body) => srv.call(method, '/api/warteliste' + url, { token: tAdv, body });
const status = async (s = srv) => (await fetch(s.base + '/api/warteliste/status')).json();
async function einstellen(extra = {}) {
  return adm('PUT', '/admin/einstellungen', { aktiv: true, plaetze: 5, fenster: 'November', plaetze_zeigen: true, liste_zeigen: true, liste_ab: 5, ...extra });
}
async function aufraeumen() {
  await pool.query('DELETE FROM warteliste');
  await pool.query('DELETE FROM warteliste_einstellungen');
  H.mails.length = 0;
}
test.beforeEach(aufraeumen);

test('Schalter AUS (Standard): keine Anzeige, keine Zähler, kein Eintrag, keine Mails', async () => {
  const s = await status();
  assert.deepEqual(s, { aktiv: false });
  const r = await eintrag();
  assert.equal(r.status, 403);
  await wait();
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM warteliste')).rows[0].n, 0);
  assert.equal(H.mails.length, 0);
  // auch mit Zählern in den Einstellungen bleibt bei ausgeschaltetem Schalter alles leer
  await einstellen({ aktiv: false });
  assert.deepEqual(await status(), { aktiv: false });
});

test('Einstellungen und Verwaltung nur für die Beraterin', async () => {
  for (const [m, u] of [['GET', '/admin/einstellungen'], ['PUT', '/admin/einstellungen'], ['GET', '/admin/liste'], ['GET', '/admin/export.csv'], ['PUT', '/admin/eintraege/1/status'], ['POST', '/admin/eintraege/1/einladen'], ['DELETE', '/admin/eintraege/1']]) {
    const r = await srv.call(m, '/api/warteliste' + u, { body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, m + ' ' + u);
    const k = await srv.call(m, '/api/warteliste' + u, { token: H.clientToken(1), body: m === 'GET' ? undefined : {} });
    assert.ok([401, 403].includes(k.status), 'Klient: ' + m + ' ' + u + ' ' + k.status);
  }
  const g = await adm('GET', '/admin/einstellungen');
  assert.equal(g.status, 200);
  assert.equal(g.body.einstellungen.aktiv, false, 'Standard ist AUS');
  assert.equal(g.body.einstellungen.liste_ab, 5, 'Standard Mindestzahl 5');
  assert.equal(g.body.link, 'https://rhetoriq.ch/platz');
});

test('Einstellungen werden bereinigt gespeichert', async () => {
  const r = await einstellen({ plaetze: -3, fenster: ' Novem\nber — früh ', liste_ab: 'x', plaetze_zeigen: 'ja' });
  assert.equal(r.body.einstellungen.plaetze, 0);
  assert.ok(!/[\n–—]/.test(r.body.einstellungen.fenster));
  assert.equal(r.body.einstellungen.liste_ab, 5);
  assert.equal(r.body.einstellungen.plaetze_zeigen, false);
});

test('Eintrag: gespeichert, Bestätigung an die Person (Sie), Hinweis an Lorena', async () => {
  await einstellen();
  const r = await eintrag();
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.schon, false);
  await wait();
  const row = (await pool.query('SELECT * FROM warteliste')).rows[0];
  assert.equal(row.email, 'anna@firma.ch');
  assert.equal(row.unternehmen, 'Muster AG');
  assert.equal(row.status, 'neu');
  assert.equal(row.einwilligung, true);
  assert.equal(row.monat, 'November');
  const b = kinds('warteliste_bestaetigung');
  assert.equal(b.length, 1);
  assert.equal(b[0].to, 'anna@firma.ch');
  assert.equal(b[0].senderName, 'Lorena Lienhard');
  assert.ok(b[0].text.includes('Ihren Platz notiert'));
  assert.ok(b[0].text.startsWith('Guten Tag Anna Muster'));
  assert.ok(!b[0].attachments);
  const h = kinds('warteliste_hinweis');
  assert.equal(h.length, 1);
  assert.equal(h[0].to, 'contact@lorenalienhard.ch');
  assert.ok(h[0].text.includes('Muster AG') && h[0].text.includes('Versicherung') && h[0].text.includes('anna@firma.ch'));
  for (const m of H.mails) assert.ok(!/[–—―ß]/.test(m.subject + m.text), 'Schreibregeln: ' + m.kind);
});

test('Zweite Adresse für Lorena (ADVISOR_NOTIFY_EMAIL_2) erhält den Hinweis ebenfalls', async () => {
  process.env.ADVISOR_NOTIFY_EMAIL_2 = 'zweite@test.ch';
  try {
    await einstellen();
    await eintrag();
    await wait();
    assert.deepEqual(kinds('warteliste_hinweis').map(m => m.to).sort(), ['contact@lorenalienhard.ch', 'zweite@test.ch']);
  } finally { delete process.env.ADVISOR_NOTIFY_EMAIL_2; }
});

test('Einwilligung ist Pflicht, ebenso Name, E-Mail, Unternehmen und Branche', async () => {
  await einstellen();
  for (const [felder, feld] of [[{ einwilligung: false }, 'einwilligung'], [{ einwilligung: undefined }, 'einwilligung'], [{ einwilligung: 'true' }, 'einwilligung'], [{ name: '' }, 'name'], [{ name: 'A' }, 'name'],
    [{ name: 'https://spam.example' }, 'name'], [{ email: 'keine-adresse' }, 'email'], [{ unternehmen: '' }, 'unternehmen'], [{ branche: '' }, 'branche'], [{ name: 5 }, 'name']]) {
    const r = await eintrag(felder);
    assert.equal(r.status, 400, JSON.stringify(felder));
    assert.equal(r.body.feld, feld);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM warteliste')).rows[0].n, 0);
  assert.equal(H.mails.length, 0);
});

test('Längen und Bereinigung: Anliegen optional, Eingaben einzeilig, Steuerzeichen entfernt', async () => {
  await einstellen();
  assert.equal((await eintrag({ anliegen: undefined })).status, 200);
  const lang = await eintrag({ email: 'lang@firma.ch', anliegen: 'x'.repeat(3001) });
  assert.equal(lang.status, 400);
  const r = await eintrag({ email: 'zeile@firma.ch', name: 'Bernd\r\nBcc: boese', unternehmen: 'Firma\nZeile zwei', branche: 'Handel — Export' });
  assert.equal(r.status, 200);
  const row = (await pool.query(`SELECT * FROM warteliste WHERE email='zeile@firma.ch'`)).rows[0];
  for (const k of ['name', 'unternehmen', 'branche']) assert.ok(!/[\r\n]/.test(row[k]) && !/[–—]/.test(row[k]), k);
  await wait();
  const m = kinds('warteliste_bestaetigung').find(x => x.to === 'zeile@firma.ch');
  assert.ok(!/[\r\n]/.test(m.subject));
});

test('Echte Zähler: Plätze minus eingeladene und aufgenommene, nie unter 0, Anzahl erst ab Mindestzahl', async () => {
  await einstellen({ plaetze: 3, liste_ab: 3 });
  let s = await status();
  assert.equal(s.aktiv, true);
  assert.equal(s.plaetze, 3); assert.equal(s.frei, 3); assert.equal(s.fenster, 'November');
  assert.equal(s.anzahl, undefined, 'unter der Mindestzahl keine Zahl');
  assert.ok(s.ticket);
  const ids = [];
  for (const n of ['a', 'b', 'c', 'd']) {
    const r = await eintrag({ email: n + '@firma.ch', name: 'Person ' + n });
    assert.equal(r.status, 200);
  }
  ids.push(...(await pool.query('SELECT id FROM warteliste ORDER BY id')).rows.map(r => r.id));
  s = await status();
  assert.equal(s.anzahl, 4, 'echte Zahl, weil sie die Mindestzahl erreicht');
  assert.equal(s.frei, 3, 'Neue Einträge belegen keinen Platz');
  await adm('PUT', `/admin/eintraege/${ids[0]}/status`, { status: 'eingeladen' });
  await adm('PUT', `/admin/eintraege/${ids[1]}/status`, { status: 'aufgenommen' });
  s = await status();
  assert.equal(s.frei, 1);
  await adm('PUT', `/admin/eintraege/${ids[2]}/status`, { status: 'aufgenommen' });
  await adm('PUT', `/admin/eintraege/${ids[3]}/status`, { status: 'aufgenommen' });
  s = await status();
  assert.equal(s.frei, 0, 'nie unter 0');
  assert.equal(s.anzahl, 4);
  // weniger Plätze als belegt: weiterhin 0
  await einstellen({ plaetze: 1 });
  assert.equal((await status()).frei, 0);
  // abgesagt zählt weder als Platz noch als Eintrag auf der Liste
  await adm('PUT', `/admin/eintraege/${ids[3]}/status`, { status: 'abgesagt' });
  await einstellen({ plaetze: 5, liste_ab: 1 });
  s = await status();
  assert.equal(s.frei, 2);
  assert.equal(s.anzahl, 3);
  // anderes Aufnahmefenster: die Plätze beginnen von vorn
  await einstellen({ plaetze: 3, fenster: 'Dezember' });
  assert.equal((await status()).frei, 3);
});

test('Von Hand vergebene Plätze zählen echt mit, nie unter 0, ungültige Werte werden 0', async () => {
  await einstellen({ plaetze: 5, fenster: 'Vergeben-Test', plaetze_zeigen: true, bereits_vergeben: 1 });
  assert.equal((await status()).frei, 4, '5 Plätze, einer an einen bestehenden Kunden vergeben');
  await einstellen({ plaetze: 5, fenster: 'Vergeben-Test', plaetze_zeigen: true, bereits_vergeben: 9 });
  assert.equal((await status()).frei, 0, 'nie unter 0');
  await einstellen({ plaetze: 5, fenster: 'Vergeben-Test', plaetze_zeigen: true, bereits_vergeben: -2 });
  assert.equal((await status()).frei, 5, 'ungültiger Wert wird 0');
  await einstellen({ plaetze: 5, fenster: 'Vergeben-Test', plaetze_zeigen: true, bereits_vergeben: 1.5 });
  assert.equal((await status()).frei, 5, 'keine Kommazahl');
  const r = await adm('GET', '/admin/einstellungen');
  assert.equal(r.body.einstellungen.bereits_vergeben, 0);
});

test('Zähler nur, wenn Lorena sie erlaubt', async () => {
  await einstellen({ plaetze_zeigen: false, liste_zeigen: false, liste_ab: 0 });
  await eintrag();
  const s = await status();
  assert.equal(s.aktiv, true);
  for (const k of ['plaetze', 'frei', 'fenster', 'anzahl']) assert.equal(s[k], undefined, k);
  await einstellen({ plaetze_zeigen: true, liste_zeigen: false });
  const t = await status();
  assert.equal(t.frei, 5); assert.equal(t.anzahl, undefined);
  // Plätze 0 oder ohne Fensternamen: keine Zeile über Plätze
  await einstellen({ plaetze: 0 });
  assert.equal((await status()).frei, undefined);
  await einstellen({ plaetze: 4, fenster: '' });
  assert.equal((await status()).frei, undefined);
});

test('Doppeleintrag: zweiter Eintrag wird freundlich gemeldet, keine zweite Zeile, keine neuen Mails', async () => {
  await einstellen();
  await eintrag();
  await wait();
  const vorher = H.mails.length;
  const r = await eintrag({ email: 'ANNA@Firma.ch', name: 'Anna Anders' });
  assert.equal(r.status, 200);
  assert.equal(r.body.schon, true);
  assert.ok(/bereits auf der Liste/.test(r.body.meldung));
  await wait();
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM warteliste')).rows[0].n, 1);
  assert.equal(H.mails.length, vorher);
});

test('Missbrauchsschutz: Herkunft, Honeypot, Ticket, Mindestzeit', async () => {
  await einstellen();
  assert.equal((await eintrag({}, srv).then(() => post(srv, { name: 'X Y', email: 'x@y.ch', unternehmen: 'Fa', branche: 'Br', einwilligung: true, ticket: B.ticketNeu(new Date(Date.now() - 10000)) }, { origin: 'https://boese.example' }))).status, 401);
  assert.equal((await post(srv, { name: 'X Y', email: 'x@y.ch', unternehmen: 'Fa', branche: 'Br', einwilligung: true, ticket: B.ticketNeu(new Date(Date.now() - 10000)) }, { origin: null })).status, 401);
  await pool.query('DELETE FROM warteliste'); H.mails.length = 0;
  const bot = await eintrag({ email: 'bot@firma.ch', website2: 'http://spam.example' });
  assert.equal(bot.status, 200); assert.equal(bot.body.ok, true);
  assert.equal((await eintrag({ ticket: undefined })).status, 400);
  assert.equal((await eintrag({ ticket: 'abc.def' })).status, 400);
  assert.equal((await eintrag({ ticket: B.ticketNeu(new Date(Date.now() - 7 * 3600000)) })).status, 400, 'zu altes Ticket');
  assert.equal((await eintrag({ ticket: B.ticketNeu(new Date(Date.now() + 60000)) })).status, 400, 'Ticket aus der Zukunft');
  const schnell = await eintrag({ ticket: B.ticketNeu(new Date()) });
  assert.equal(schnell.status, 429, 'unter 4 Sekunden');
  await wait();
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM warteliste')).rows[0].n, 0);
  assert.equal(H.mails.length, 0);
});

test('Rate-Limit pro IP und pro E-Mail', async () => {
  await einstellen();
  const s1 = [];
  for (let i = 0; i < 4; i++) s1.push((await eintrag({ email: `ip${i}@firma.ch` }, srvIp)).status);
  assert.deepEqual(s1, [200, 200, 200, 429]);
  const s2 = [];
  for (let i = 0; i < 3; i++) s2.push((await eintrag({ email: 'gleich@firma.ch' }, srvEmail)).status);
  assert.deepEqual(s2, [200, 200, 429]);
});

test('Tageslimit', async () => {
  await einstellen();
  for (let i = 0; i < W.TAGESLIMIT; i++) await pool.query(`INSERT INTO warteliste (name, email, unternehmen, branche, einwilligung) VALUES ('P','p${i}@x.ch','F','B',TRUE)`);
  const r = await eintrag({ email: 'zuviel@firma.ch' });
  assert.equal(r.status, 429);
  assert.ok(/morgen/.test(r.body.error));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM warteliste')).rows[0].n, W.TAGESLIMIT);
});

test('Verwaltung: Liste nach Datum, Status, Einladen, Löschen', async () => {
  await einstellen();
  await pool.query(`INSERT INTO warteliste (name, email, unternehmen, branche, einwilligung, created_at) VALUES ('Alt','alt@x.ch','Alt AG','Handel',TRUE,'2026-09-01T10:00:00Z')`);
  await pool.query(`INSERT INTO warteliste (name, email, unternehmen, branche, einwilligung, created_at) VALUES ('Neu','neu@x.ch','Neu AG','Bau',TRUE,'2026-10-01T10:00:00Z')`);
  const l = await adm('GET', '/admin/liste');
  assert.deepEqual(l.body.eintraege.map(e => e.name), ['Neu', 'Alt'], 'nach Datum, neueste zuerst');
  assert.equal(l.body.zaehler.anzahl, 2);
  const id = l.body.eintraege[0].id;
  assert.equal((await adm('PUT', `/admin/eintraege/${id}/status`, { status: 'geheim' })).status, 400);
  assert.equal((await adm('PUT', `/admin/eintraege/abc/status`, { status: 'neu' })).status, 400);
  assert.equal((await adm('PUT', `/admin/eintraege/9999/status`, { status: 'neu' })).status, 404);
  const up = await adm('PUT', `/admin/eintraege/${id}/status`, { status: 'aufgenommen' });
  assert.equal(up.body.eintrag.status, 'aufgenommen');
  assert.equal(up.body.eintrag.monat, 'November');
  assert.equal(up.body.zaehler.frei, 4);
  H.mails.length = 0;
  const ein = await adm('POST', `/admin/eintraege/${l.body.eintraege[1].id}/einladen`, {});
  assert.equal(ein.status, 200);
  assert.equal(ein.body.eintrag.status, 'eingeladen');
  assert.equal(ein.body.zaehler.frei, 3);
  const m = kinds('warteliste_einladung');
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'alt@x.ch');
  assert.ok(m[0].text.includes('https://rhetoriq.ch/termin') && m[0].text.startsWith('Guten Tag Alt'));
  assert.ok(!/[–—―ß]/.test(m[0].subject + m[0].text));
  assert.equal((await adm('POST', `/admin/eintraege/9999/einladen`, {})).status, 404);
  const del = await adm('DELETE', `/admin/eintraege/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await adm('DELETE', `/admin/eintraege/${id}`)).status, 404);
  assert.equal((await adm('GET', '/admin/liste')).body.eintraege.length, 1);
  // gelöschte Adresse darf sich neu eintragen
  assert.equal((await eintrag({ email: 'neu@x.ch' })).status, 200);
});

test('CSV-Export: nur Beraterin, Kopfzeile, Formeln entschärft', async () => {
  await einstellen();
  await pool.query(`INSERT INTO warteliste (name, email, unternehmen, branche, anliegen, einwilligung) VALUES ('=SUMME(A1)','e@x.ch','Fa "Q"','Bau','Zeile',TRUE)`);
  const r = await adm('GET', '/admin/export.csv');
  const res = await srv.call('GET', '/api/warteliste/admin/export.csv', { token: tAdv, raw: true });
  assert.ok((res.headers.get('content-type') || '').startsWith('text/csv'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM für Excel');
  const t = '﻿' + buf.toString('utf8').replace(/^﻿/, '');
  assert.ok(t.startsWith('﻿"Datum";"Name";"E-Mail";"Unternehmen";"Branche";"Anliegen";"Status";"Monat";"Einwilligung"'));
  assert.ok(t.includes(`"'=SUMME(A1)"`));
  assert.ok(t.includes('"Fa ""Q"""'));
  assert.ok(t.includes('"ja"'));
  assert.ok(r.status === 200 || r.status === null);
});
