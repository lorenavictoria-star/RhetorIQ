// Weitere Google-Kalender (nur lesen): Scope-Prüfung, Kalenderauswahl, Synchronisation (initial, inkrementell, 410), Sonderfälle, Schreibschutz,
// Planung um die Termine, Datenschutz, Trennen, Assistent. Alles mit gemockter Google-API (fakeGoogle).
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test-geheimnis-12345678';
process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { fakeGoogle, SCOPE, SCOPE_LESEN } = require('../test-support/fakeGoogle');
const Z = require('../lib/zeit');
const D = require('../lib/tagesplanDaten');
const T = require('../lib/tagesplan');
const KD = require('../lib/kalendersync/daten');
const GA = require('../lib/kalendersync/googleApi');
const Q = require('../lib/kalendersync/googleQuellen');
const google = require('../lib/kalendersync/google');
const AP = require('../lib/assistentPlan');
const A = require('../lib/assistent');

let srv, g, klient;
const log = [];
for (const k of ['log', 'error', 'warn', 'info']) { const o = console[k]; console[k] = (...a) => { log.push(a.map(String).join(' ')); if (process.env.KS_DEBUG) o(...a); }; }
const heute = Z.heute();
const tag = (n) => Z.addTage(heute, n);
const call = (m, u, body, token = H.advisorToken()) => srv.call(m, u, { token, body: m === 'GET' ? undefined : body });
// Ein Werktag (Mittwoch, kein Feiertag) in der Zukunft
const WT = (() => { let d = Z.addTage(heute, 3); while (Z.wd(d) !== 3 || Z.feiertagName(d)) d = Z.addTage(d, 1); return d; })();
const zt = (datum, hhmm) => Z.zuDate(datum, Z.zeitZuMin(hhmm)).toISOString();
const zeitEv = (datum, von, bis, o = {}) => ({ summary: 'Sitzung', start: { dateTime: zt(datum, von) }, end: { dateTime: zt(datum, bis) }, ...o });
const ganzEv = (von, bisInklusive, o = {}) => ({ summary: 'Ganzer Tag', start: { date: von }, end: { date: Z.addTage(bisInklusive, 1) }, ...o });

const PRIM = 'lorena@example.ch', FEI = 'ch.german#holiday@group.v.calendar.google.com', GEB = 'addressbook#contacts@group.v.calendar.google.com';
function konto() {
  g.kalenderDazu(PRIM, { primary: true, summary: PRIM, backgroundColor: '#4285f4' });
  g.kalenderDazu(FEI, { summary: 'Feiertage in der Schweiz', backgroundColor: '#0b8043' });
  g.kalenderDazu(GEB, { summary: 'Geburtstage', backgroundColor: '#8e24aa' });
}
async function zuruecksetzen() {
  for (const t of ['kalender_google', 'kalender_google_state', 'kalender_google_map', 'kalender_ausgeblendet', 'kalender_fremd', 'kalender_google_quellen', 'kalender_google_termine', 'tagesplan_eintraege', 'tagesplan_positionen', 'review_requests']) await H.pool.query(`DELETE FROM ${t}`);
  g = fakeGoogle();
  GA._setHttp({ fetch: g.fetch, sleep: g.sleep });
  GA.tokenVergessen(1);
  google._setZeitgeber({ entprellung: 25, wiederholung: [15, 15, 15], webhookEntprellung: 10 });
  log.length = 0;
}
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await H.pool.query(`CREATE TABLE inquiries (id SERIAL PRIMARY KEY, name TEXT, company TEXT, status TEXT NOT NULL DEFAULT 'neu', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await H.pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await require('../lib/schemaRedesign').ensureSchema();
  await D.ensureSchema();
  klient = await H.addClient('Muster AG');
  srv = await H.startApp([['/api/tagesplan', require('../routes/tagesplan')], ['/api/kalender/google', require('../routes/kalenderGoogle')], ['/api/assistent', require('../routes/assistent')]]);
});
test.after(async () => { await srv.close(); });
test.beforeEach(zuruecksetzen);

// Verbindung mit oder ohne Lesezugriff, danach voller Abgleich (Kalenderliste, Auswahl, erster Abgleich)
async function verbunden({ lesen = true, kalender = true } = {}) {
  g.scope = lesen ? `${SCOPE} ${SCOPE_LESEN}` : SCOPE;
  if (kalender) konto();
  GA.tokenVergessen(1);
  await google.verbindungHerstellen(1, 'gute-code', 'verifier-fuer-test');
  await google.synchronisiere(1, { voll: true });
  await google._ruhe();
}
const quelle = async (cal) => (await KD.quellenAlle(1)).find(x => x.calendar_id === cal);
const termine = async () => (await H.pool.query('SELECT * FROM kalender_google_termine ORDER BY id')).rows;
const titel = async () => (await termine()).map(t => t.titel).sort();
const waehlen = async (cal, aktiv = true) => { const q = await quelle(cal); const r = await call('PATCH', `/api/kalender/google/quellen/${q.id}`, { aktiv }); await google._ruhe(); return r; };
const sync = async (o) => { const r = await google.synchronisiere(1, o); await google._ruhe(); return r; };
const blockTitel = (plan) => plan.bloecke.map(b => b.titel).sort();
const lesen = (cal) => g.listen.filter(l => l.kalender === cal);
const webhook = (id, token, zustand = 'exists') => fetch(`${srv.base}/api/kalender/google/webhook`, { method: 'POST', headers: { 'X-Goog-Channel-ID': id || '', 'X-Goog-Channel-Token': token || '', 'X-Goog-Resource-State': zustand } });

// ── 1. Scope ──
test('Scope: Verbindung ohne Lesezugriff läuft wie bisher, die Oberfläche bekommt den Hinweis und den Knopf', async () => {
  await verbunden({ lesen: false });
  const row = await KD.googleZeile(1);
  assert.equal(row.scopes, SCOPE, 'Scope-Liste aus der Token-Antwort gespeichert');
  const st = (await call('GET', '/api/kalender/google/status')).body;
  assert.equal(st.verbunden, true);
  assert.equal(st.lesenErlaubt, false);
  assert.equal(st.zusatzFreigabeNoetig, true);
  assert.equal(st.zusatzFreigabeHinweis, 'Für die Anzeige deiner übrigen Termine ist eine zusätzliche Freigabe nötig.');
  const qs = await call('GET', '/api/kalender/google/quellen');
  assert.equal(qs.status, 200);
  assert.equal(qs.body.lesenErlaubt, false);
  assert.deepEqual(qs.body.kalender, []);
  assert.equal(g.log.filter(l => /calendarList/.test(l.pfad)).length, 0, 'ohne Scope kein Aufruf der Kalenderliste');
  assert.equal((await call('PATCH', '/api/kalender/google/quellen/1', { aktiv: true })).status, 409);
  // der RhetorIQ-Kalender funktioniert unverändert
  const e = await call('POST', '/api/tagesplan/termine', { titel: 'Workshop', typ: 'kunde', datum: tag(2), beginn: '10:00', ende: '11:30' });
  assert.equal(e.status, 201);
  await google._ruhe();
  assert.equal(g.aktive().filter(x => x.summary === 'Workshop').length, 1);
  assert.equal((await sync()).ok, true);
  assert.deepEqual(await termine(), []);
  assert.equal(g.fremdAufrufe().length, 0);
});

test('Scope: mit Lesezugriff ist keine zusätzliche Freigabe nötig, die Scope-Liste wird gespeichert', async () => {
  await verbunden();
  assert.equal((await KD.googleZeile(1)).scopes, `${SCOPE} ${SCOPE_LESEN}`);
  const st = (await call('GET', '/api/kalender/google/status')).body;
  assert.equal(st.lesenErlaubt, true);
  assert.equal(st.zusatzFreigabeNoetig, false);
  assert.equal(st.zusatzFreigabeHinweis, null);
});

test('Scope: Verbinden über die Routen fordert beide Scopes an und speichert die erteilten', async () => {
  g.scope = `${SCOPE} ${SCOPE_LESEN}`;
  konto();
  const raw = await srv.call('POST', '/api/kalender/google/verbinden', { token: H.advisorToken(), body: {}, raw: true });
  const j = await raw.json();
  const u = new URL(j.url);
  assert.deepEqual(u.searchParams.get('scope').split(' '), [SCOPE, SCOPE_LESEN]);
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  const cookie = (raw.headers.get('set-cookie') || '').split(';')[0];
  const r = await fetch(`${srv.base}/api/kalender/google/callback?code=gute-code&state=${encodeURIComponent(u.searchParams.get('state'))}`, { redirect: 'manual', headers: { cookie } });
  assert.match(r.headers.get('location'), /google=verbunden/);
  await google._ruhe();
  await new Promise(res => setTimeout(res, 50));
  await google._ruhe();
  assert.equal((await KD.googleZeile(1)).scopes, `${SCOPE} ${SCOPE_LESEN}`);
  assert.ok((await KD.quellenAlle(1)).length >= 3, 'Kalenderliste nach dem Verbinden geladen');
});

test('Scope: neue Verbindung ohne Lesezugriff entfernt zuvor gelesene Termine und Kanäle', async () => {
  await verbunden();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Vertraulich' }));
  await sync();
  assert.deepEqual(await titel(), ['Vertraulich']);
  g.scope = SCOPE; // Lorena verweigert beim erneuten Verbinden den Lesezugriff
  GA.tokenVergessen(1);
  await google.verbindungHerstellen(1, 'gute-code', 'v');
  assert.deepEqual(await termine(), []);
  assert.deepEqual(await KD.quellenAlle(1), []);
  assert.equal((await call('GET', '/api/kalender/google/status')).body.zusatzFreigabeNoetig, true);
  assert.ok(g.gestoppt.length >= 1, 'Kanäle der weiteren Kalender beendet');
});

// ── 2. Auswahl ──
test('Kalenderliste ohne den RhetorIQ-Kalender, Voreinstellung nur Hauptkalender, Farbe von Google', async () => {
  g.listeSeite = 2; // Seitenweise lesen
  await verbunden();
  const r = await call('GET', '/api/kalender/google/quellen');
  assert.equal(r.status, 200);
  assert.equal(r.body.lesenErlaubt, true);
  const namen = r.body.kalender.map(k => k.name).sort();
  assert.deepEqual(namen, [PRIM, 'Feiertage in der Schweiz', 'Geburtstage'].sort());
  assert.ok(!r.body.kalender.some(k => k.name === 'RhetorIQ'), 'der Kalender RhetorIQ gehört nicht in die Liste');
  assert.ok(!(await KD.quellenAlle(1)).some(q => q.calendar_id === g.kalender.id));
  assert.deepEqual(r.body.kalender.filter(k => k.aktiv).map(k => k.name), [PRIM], 'nur der Hauptkalender ist angehakt');
  assert.equal(r.body.kalender.find(k => k.primaer).name, PRIM);
  assert.equal(r.body.kalender.find(k => k.primaer).farbe, '#4285f4');
  assert.equal(r.body.kalender.find(k => k.name === 'Geburtstage').farbe, '#8e24aa');
  assert.deepEqual(Object.keys(r.body.kalender[0]).sort(), ['aktiv', 'farbe', 'fehler', 'fehlerSeit', 'id', 'letzteSync', 'name', 'primaer'], 'keine Sync-Tokens oder Kanäle nach aussen');
  // gelesen wurde nur der Hauptkalender, der RhetorIQ-Kalender nicht als Quelle
  assert.deepEqual([...new Set(g.listen.filter(l => l.kalender).map(l => l.kalender))], [PRIM]);
});

test('Auswahl: Anhaken liest sofort und beobachtet, Abwählen entfernt Termine und Kanal, Farbe ist änderbar, Eingaben werden geprüft', async () => {
  await verbunden();
  g.fremdNeu(FEI, ganzEv(tag(5), tag(5), { summary: 'Bundesfeier' }));
  assert.deepEqual(await titel(), [], 'abgewählte Kalender werden nicht gelesen');
  const an = await waehlen(FEI, true);
  assert.equal(an.status, 200);
  assert.equal(an.body.aktiv, true);
  assert.deepEqual(await titel(), ['Bundesfeier']);
  const q = await quelle(FEI);
  assert.ok(q.channel_id && q.channel_token_hash, 'Kanal pro Kalender');
  assert.ok(g.kanaele.some(k => k.kalender === FEI));
  const aus = await waehlen(FEI, false);
  assert.equal(aus.body.aktiv, false);
  assert.deepEqual(await titel(), []);
  assert.equal((await quelle(FEI)).channel_id, null);
  assert.ok(g.gestoppt.some(x => x.id === q.channel_id), 'Kanal bei Google beendet');
  // Farbe
  assert.equal((await call('PATCH', `/api/kalender/google/quellen/${q.id}`, { farbe: '#112233' })).body.farbe, '#112233');
  for (const farbe of ['rot', '#12345', 'javascript:alert(1)', 5]) assert.equal((await call('PATCH', `/api/kalender/google/quellen/${q.id}`, { farbe })).status, 400, String(farbe));
  assert.equal((await call('PATCH', `/api/kalender/google/quellen/${q.id}`, { aktiv: 'ja' })).status, 400);
  assert.equal((await call('PATCH', '/api/kalender/google/quellen/9999', { aktiv: true })).status, 404);
  assert.equal((await call('PATCH', '/api/kalender/google/quellen/abc', { aktiv: true })).status, 400);
  // Die Farbe bleibt bei einem erneuten Abgleich mit Google erhalten
  await call('GET', '/api/kalender/google/quellen?abgleichen=1');
  assert.equal((await quelle(FEI)).farbe, '#112233');
});

test('Kalenderliste: ein bei Google verschwundener Kalender wird samt Terminen entfernt, neue Kalender kommen abgewählt dazu', async () => {
  await verbunden();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00'));
  await sync();
  assert.equal((await termine()).length, 1);
  g.kalenderListe.splice(g.kalenderListe.findIndex(k => k.id === PRIM), 1);
  g.kalenderDazu('neu@example.ch', { summary: 'Neuer Kalender' });
  const r = await call('GET', '/api/kalender/google/quellen?abgleichen=1');
  assert.ok(!r.body.kalender.some(k => k.name === PRIM));
  assert.equal(r.body.kalender.find(k => k.name === 'Neuer Kalender').aktiv, false);
  assert.deepEqual(await termine(), []);
});

// ── 3. Synchronisation ──
test('Initial: 60 Tage zurück bis 180 Tage voraus, singleEvents, schlanke Felder; ausserhalb des Fensters wird nichts gespeichert', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(tag(-59), '09:00', '10:00', { summary: 'Alt aber drin' }));
  g.fremdNeu(PRIM, zeitEv(tag(-70), '09:00', '10:00', { summary: 'Zu alt' }));
  g.fremdNeu(PRIM, zeitEv(tag(170), '09:00', '10:00', { summary: 'Weit voraus' }));
  g.fremdNeu(PRIM, zeitEv(tag(200), '09:00', '10:00', { summary: 'Zu weit' }));
  await verbunden({ kalender: false });
  const erste = lesen(PRIM)[0];
  assert.equal(erste.singleEvents, 'true');
  assert.equal(erste.syncToken, undefined);
  assert.equal(erste.timeMin, zt(tag(-60), '00:00'));
  assert.equal(erste.timeMax, zt(tag(181), '00:00'));
  assert.ok(!/description|organizer|creator/.test(erste.fields) && /attendees\(self,responseStatus\)/.test(erste.fields), 'nur die nötigen Felder, keine Teilnehmerlisten');
  assert.deepEqual(await titel(), ['Alt aber drin', 'Weit voraus']);
  const q = await quelle(PRIM);
  assert.ok(q.sync_token, 'Sync-Token gespeichert');
  assert.equal(q.fenster_bis, tag(180));
});

test('Inkrementell: ab dem zweiten Lauf mit syncToken, nur Änderungen, Absagen entfernen', async () => {
  await verbunden();
  const a = g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Erster' }));
  g.fremdNeu(PRIM, zeitEv(WT, '14:00', '15:00', { summary: 'Zweiter' }));
  await sync();
  assert.deepEqual(await titel(), ['Erster', 'Zweiter']);
  const vorher = g.listen.length;
  g.fremdAendern(PRIM, a, { ...zeitEv(WT, '11:00', '12:00'), summary: 'Erster verschoben' });
  await sync();
  const l = g.listen.slice(vorher).filter(x => x.kalender === PRIM);
  assert.equal(l.length, 1);
  assert.ok(l[0].syncToken, 'inkrementell mit syncToken');
  assert.equal(l[0].timeMin, undefined);
  assert.deepEqual(await titel(), ['Erster verschoben', 'Zweiter']);
  const t = (await termine()).find(x => x.titel === 'Erster verschoben');
  assert.equal(t.beginn_min, 660);
  g.fremdAbsagen(PRIM, a);
  await sync();
  assert.deepEqual(await titel(), ['Zweiter']);
  // ohne Änderungen kommt nichts Neues
  const n = (await termine()).length;
  await sync();
  assert.equal((await termine()).length, n);
});

test('410: volle Neusynchronisation, was bei Google fehlt, verschwindet', async () => {
  await verbunden();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Bleibt' }));
  const weg = g.fremdNeu(PRIM, zeitEv(WT, '14:00', '15:00', { summary: 'Weg ohne Meldung' }));
  await sync();
  assert.deepEqual(await titel(), ['Bleibt', 'Weg ohne Meldung']);
  g.fremd.get(PRIM).delete(weg); // Google meldet das Löschen nicht mehr (Token abgelaufen)
  g.fremdNeu(PRIM, zeitEv(WT, '16:00', '17:00', { summary: 'Neu' }));
  g.gone410Fremd = true;
  g.listen.length = 0;
  const r = await sync();
  assert.equal(r.ok, true);
  const l = lesen(PRIM);
  assert.equal(l.length, 2);
  assert.ok(l[0].syncToken && !l[1].syncToken && l[1].timeMin, 'erst mit Token (410), dann vollständig mit Zeitfenster');
  assert.deepEqual(await titel(), ['Bleibt', 'Neu']);
  assert.ok((await quelle(PRIM)).sync_token);
});

test('Das Fenster wird neu gelesen, bevor es zu kurz wird', async () => {
  await verbunden();
  await H.pool.query('UPDATE kalender_google_quellen SET fenster_bis=$1', [tag(100)]);
  g.listen.length = 0;
  await sync();
  assert.ok(!lesen(PRIM)[0].syncToken && lesen(PRIM)[0].timeMax, 'volle Synchronisation mit neuem Fenster');
  assert.equal((await quelle(PRIM)).fenster_bis, tag(180));
});

test('Seitenweises Lesen grosser Kalender', async () => {
  g.seitenGroesse = 2;
  konto();
  for (let i = 0; i < 5; i++) g.fremdNeu(PRIM, zeitEv(Z.addTage(WT, i), '09:00', '10:00', { summary: 'Termin ' + i }));
  await verbunden({ kalender: false });
  assert.equal((await termine()).length, 5);
});

// ── 4. Sonderfälle ──
test('Abgesagte und abgelehnte Termine werden nicht angezeigt oder entfernt, vorläufige und Zusagen anderer bleiben', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '08:00', '09:00', { summary: 'Abgesagt', status: 'cancelled' }));
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Abgelehnt', attendees: [{ email: 'a@x.ch', responseStatus: 'accepted' }, { self: true, email: 'contact@lorenalienhard.ch', responseStatus: 'declined' }] }));
  g.fremdNeu(PRIM, zeitEv(WT, '10:00', '11:00', { summary: 'Vielleicht', attendees: [{ self: true, email: 'contact@lorenalienhard.ch', responseStatus: 'tentative' }] }));
  g.fremdNeu(PRIM, zeitEv(WT, '11:00', '12:00', { summary: 'Andere lehnt ab', attendees: [{ email: 'b@x.ch', responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] }));
  const spaeter = g.fremdNeu(PRIM, zeitEv(WT, '13:00', '14:00', { summary: 'Erst zugesagt', attendees: [{ self: true, responseStatus: 'accepted' }] }));
  await verbunden({ kalender: false });
  assert.deepEqual(await titel(), ['Andere lehnt ab', 'Erst zugesagt', 'Vielleicht']);
  const plan = await D.planFuer(1, WT);
  assert.deepEqual(blockTitel(plan), ['Andere lehnt ab', 'Erst zugesagt', 'Vielleicht']);
  // nachträglich abgelehnt: verschwindet beim nächsten Abgleich
  g.fremdAendern(PRIM, spaeter, { attendees: [{ self: true, responseStatus: 'declined' }] });
  await sync();
  assert.deepEqual(await titel(), ['Andere lehnt ab', 'Vielleicht']);
  // wieder zugesagt: kommt zurück
  g.fremdAendern(PRIM, spaeter, { attendees: [{ self: true, responseStatus: 'accepted' }] });
  await sync();
  assert.ok((await titel()).includes('Erst zugesagt'));
});

test('«Verfügbar» (transparent) wird angezeigt, sperrt aber keine Zeit; besetzte Termine sperren', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '07:00', '12:00', { summary: 'Verfügbar-Block', transparency: 'transparent' }));
  await verbunden({ kalender: false });
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','x', TRUE)`, [klient.id]);
  let plan = await D.planFuer(1, WT);
  const b = plan.bloecke.find(x => x.titel === 'Verfügbar-Block');
  assert.ok(b && b.fremd && b.google && b.frei === true, 'wird angezeigt');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].beginn, 450, 'Aufgabe liegt mitten im Verfügbar-Block, er sperrt nichts');
  // dasselbe Zeitfenster als besetzter Termin sperrt
  g.fremdNeu(PRIM, zeitEv(WT, '07:00', '09:30', { summary: 'Besetzt-Block' }));
  await sync();
  plan = await D.planFuer(1, WT);
  assert.equal(plan.bloecke.find(x => x.titel === 'Besetzt-Block').frei, false);
  assert.equal(plan.items[0].beginn, 570, 'direkt nach dem besetzten Termin');
});

test('Planung: Aufgaben liegen nie auf besetzten Zeiten, mehrere Termine und mehrere Kalender', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '07:30', '08:30', { summary: 'A' }));
  g.fremdNeu(FEI, zeitEv(WT, '08:30', '09:30', { summary: 'B' }));
  await verbunden({ kalender: false });
  await waehlen(FEI, true);
  for (let i = 0; i < 4; i++) await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','x', TRUE)`, [klient.id]);
  const plan = await D.planFuer(1, WT);
  assert.equal(plan.items.length, 4);
  const besetzt = plan.bloecke.filter(b => !b.ganztaegig && !b.frei);
  assert.equal(besetzt.length, 2);
  for (const i of plan.items) for (const b of besetzt) assert.ok(i.ende <= b.beginn || i.beginn >= b.ende, `${i.start} kollidiert mit ${b.titel}`);
  assert.equal(plan.items[0].beginn, 570);
});

test('Ganztägige Termine: ein Tag, mehrere Tage (Ende bei Google ist exklusiv), kein Zeitblock, der Tag bleibt Arbeitstag', async () => {
  konto();
  g.fremdNeu(PRIM, ganzEv(WT, WT, { summary: 'Konferenz' }));
  g.fremdNeu(PRIM, ganzEv(Z.addTage(WT, 7), Z.addTage(WT, 9), { summary: 'Reise' }));
  await verbunden({ kalender: false });
  const rows = await termine();
  const reise = rows.find(r => r.titel === 'Reise');
  assert.equal(reise.datum_von, Z.addTage(WT, 7));
  assert.equal(reise.datum_bis, Z.addTage(WT, 9));
  assert.equal(reise.ganztaegig, true);
  const plan = await D.planFuer(1, WT);
  const k = plan.bloecke.find(b => b.titel === 'Konferenz');
  assert.ok(k.ganztaegig && k.beginn == null && k.fremd);
  assert.equal(plan.arbeitstag, true);
  for (let i = 0; i <= 3; i++) {
    const p = await D.planFuer(1, Z.addTage(WT, 6 + i));
    assert.equal(p.bloecke.some(b => b.titel === 'Reise'), i >= 1 && i <= 3, 'Tag ' + i);
  }
});

test('Zeitzonen: Termine mit Offset anderer Zonen landen richtig in Zürich, Mitternacht und mehrtägige Zeittermine', async () => {
  konto();
  const off = 10 - Z.zuDate(WT, 600).getUTCHours(); // Zürcher Abstand zu UTC an diesem Tag (1 oder 2)
  g.fremdNeu(PRIM, { summary: 'New York', start: { dateTime: `${WT}T09:00:00-05:00`, timeZone: 'America/New_York' }, end: { dateTime: `${WT}T10:30:00-05:00`, timeZone: 'America/New_York' } });
  g.fremdNeu(PRIM, { summary: 'UTC', start: { dateTime: `${WT}T12:00:00Z` }, end: { dateTime: `${WT}T13:00:00Z` } });
  g.fremdNeu(PRIM, { summary: 'Nachtschicht', start: { dateTime: zt(WT, '22:00') }, end: { dateTime: zt(Z.addTage(WT, 1), '02:00') } });
  g.fremdNeu(PRIM, { summary: 'Bis Mitternacht', start: { dateTime: zt(Z.addTage(WT, 2), '20:00') }, end: { dateTime: zt(Z.addTage(WT, 3), '00:00') } });
  await verbunden({ kalender: false });
  const p = await D.planFuer(1, WT);
  const ny = p.bloecke.find(b => b.titel === 'New York');
  assert.equal(ny.beginn, (14 + off) * 60);
  assert.equal(ny.ende, (15 + off) * 60 + 30);
  const utc = p.bloecke.find(b => b.titel === 'UTC');
  assert.equal(utc.beginn, (12 + off) * 60);
  const n1 = p.bloecke.find(b => b.titel === 'Nachtschicht');
  assert.deepEqual([n1.beginn, n1.ende], [1320, 1440]);
  const n2 = (await D.planFuer(1, Z.addTage(WT, 1))).bloecke.find(b => b.titel === 'Nachtschicht');
  assert.deepEqual([n2.beginn, n2.ende], [0, 120]);
  const m = await D.planFuer(1, Z.addTage(WT, 2));
  assert.deepEqual([m.bloecke.find(b => b.titel === 'Bis Mitternacht').beginn, m.bloecke.find(b => b.titel === 'Bis Mitternacht').ende], [1200, 1440]);
  assert.ok(!(await D.planFuer(1, Z.addTage(WT, 3))).bloecke.some(b => b.titel === 'Bis Mitternacht'), 'endet um 00:00, nichts am Folgetag');
});

test('Serien: einzelne Vorkommen (singleEvents), eine abgesagte Wiederholung entfernt nur diese', async () => {
  konto();
  const ids = [0, 7, 14].map(n => g.fremdNeu(PRIM, zeitEv(Z.addTage(WT, n), '08:00', '09:00', { id: `serie_${Z.addTage(WT, n).replace(/-/g, '')}T080000Z`, recurringEventId: 'serie', summary: 'Wochenrunde' })));
  await verbunden({ kalender: false });
  assert.equal((await termine()).length, 3);
  for (const n of [0, 7, 14]) assert.ok((await D.planFuer(1, Z.addTage(WT, n))).bloecke.some(b => b.titel === 'Wochenrunde'), 'Woche ' + n / 7);
  g.fremdAbsagen(PRIM, ids[1]);
  await sync();
  assert.equal((await termine()).length, 2);
  assert.ok(!(await D.planFuer(1, Z.addTage(WT, 7))).bloecke.some(b => b.titel === 'Wochenrunde'));
  assert.ok((await D.planFuer(1, Z.addTage(WT, 14))).bloecke.some(b => b.titel === 'Wochenrunde'));
});

test('Titel, Ort, Link und Anzahl der Teilnehmenden kommen im Plan an, Termine ohne Titel und fremde Links werden abgesichert', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '10:00', '11:00', { summary: 'Kundentermin', location: 'Bahnhofstrasse 1, Zürich', htmlLink: 'https://www.google.com/calendar/event?eid=abc', attendees: [{ email: 'a@x.ch' }, { email: 'b@x.ch' }, { self: true, responseStatus: 'accepted' }] }));
  g.fremdNeu(PRIM, zeitEv(WT, '12:00', '13:00', { summary: '  ', htmlLink: 'javascript:alert(1)' }));
  await verbunden({ kalender: false });
  const p = await D.planFuer(1, WT);
  const k = p.bloecke.find(b => b.titel === 'Kundentermin');
  assert.equal(k.ort, 'Bahnhofstrasse 1, Zürich');
  assert.equal(k.teilnehmer, 3);
  assert.equal(k.link, 'https://www.google.com/calendar/event?eid=abc');
  assert.equal(k.farbe, '#4285f4');
  assert.equal(k.quelle, PRIM);
  const o = p.bloecke.find(b => b.titel === 'Ohne Titel');
  assert.equal(o.link, '');
});

// ── Schreibschutz, kein Doppeln ──
test('Schreibschutz: nie ein Schreibaufruf an fremde Kalender, die Termine erscheinen weder im Kalender RhetorIQ noch im Abo-Feed', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Geheimer Hausbesuch' }));
  g.fremdNeu(FEI, ganzEv(Z.addTage(WT, 1), Z.addTage(WT, 1), { summary: 'Feiertag Test' }));
  await verbunden({ kalender: false });
  await waehlen(FEI, true);
  await waehlen(FEI, false);
  await waehlen(GEB, true);
  await call('POST', '/api/tagesplan/termine', { titel: 'Eigener Termin', typ: 'kunde', datum: WT, beginn: '14:00', ende: '15:00' });
  await google._ruhe();
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','x', TRUE)`, [klient.id]);
  await call('POST', '/api/tagesplan/plan/neu', { datum: WT });
  await sync({ voll: true });
  g.fremdAendern(PRIM, [...g.fremd.get(PRIM).keys()][0], { summary: 'Geändert' });
  await sync();
  await call('POST', '/api/kalender/google/trennen', {});
  assert.deepEqual(g.fremdSchreibaufrufe(), [], 'kein einziger Schreibaufruf an fremde Kalender');
  assert.ok(g.fremdAufrufe().length > 0 && g.fremdAufrufe().every(l => l.methode === 'GET' || /watch$/.test(l.pfad)), 'nur Lesen und Beobachten');
  // im Kalender RhetorIQ stehen nur eigene Ereignisse
  const alle = [...g.ereignisse.values()].map(e => e.summary || '').join('|');
  assert.ok(!/Hausbesuch|Feiertag Test|Geändert/.test(alle), 'keine fremden Termine im Kalender RhetorIQ');
  assert.ok(/Eigener Termin/.test(alle));
});

test('Abo-Feed und Plan-Ereignisse enthalten keine Termine aus weiteren Google-Kalendern', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Streng Vertraulich' }));
  await verbunden({ kalender: false });
  assert.ok((await D.planFuer(1, WT)).bloecke.some(b => b.titel === 'Streng Vertraulich'));
  const { ics } = await D.icsFuerTag(1, WT, { abo: true });
  assert.ok(!ics.includes('Streng Vertraulich'));
  const plan = await D.planFuer(1, WT);
  assert.ok(!JSON.stringify(D.planEreignisse(plan, { termine: true })).includes('Streng Vertraulich'));
});

// ── Webhook, Kanäle, Absicherung ──
test('Webhook: pro Kalender ein Kanal mit eigenem Geheimnis (nur als Hash gespeichert), die Meldung liest nur diesen Kalender', async () => {
  await verbunden();
  await waehlen(FEI, true);
  const kPrim = g.kanaele.find(k => k.kalender === PRIM), kFei = g.kanaele.find(k => k.kalender === FEI);
  assert.ok(kPrim && kFei && kPrim.id !== kFei.id && kPrim.token !== kFei.token, 'eigene Kanäle und Geheimnisse');
  assert.equal(kFei.address, 'https://app.test/api/kalender/google/webhook');
  const qp = await quelle(PRIM), qf = await quelle(FEI);
  assert.equal(qf.channel_token_hash, KD.sha(kFei.token));
  assert.ok(!JSON.stringify(await KD.quellenAlle(1)).includes(kFei.token) && !JSON.stringify(await KD.quellenAlle(1)).includes(kPrim.token), 'Geheimnis nie im Klartext');
  assert.equal(qp.channel_id, kPrim.id);
  // falsche Kombinationen
  assert.equal((await webhook(kPrim.id, 'falsch')).status, 404);
  assert.equal((await webhook(kPrim.id, kFei.token)).status, 404, 'Token eines anderen Kanals');
  assert.equal((await webhook('', '')).status, 404);
  g.listen.length = 0;
  assert.equal((await webhook(kFei.id, kFei.token, 'sync')).status, 200);
  await google._ruhe();
  assert.equal(g.listen.length, 0, 'sync löst nichts aus');
  // gültige Meldung des Feiertagskalenders
  g.fremdNeu(FEI, ganzEv(Z.addTage(WT, 2), Z.addTage(WT, 2), { summary: 'Brückentag' }));
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Hauptkalender neu' }));
  assert.equal((await webhook(kFei.id, kFei.token)).status, 200);
  await google._ruhe();
  assert.deepEqual(g.listen.map(l => l.kalender), [FEI], 'nur der gemeldete Kalender wurde gelesen');
  assert.deepEqual(await titel(), ['Brückentag']);
  assert.equal((await webhook(kPrim.id, kPrim.token)).status, 200);
  await google._ruhe();
  assert.deepEqual(await titel(), ['Brückentag', 'Hauptkalender neu']);
});

test('15-Minuten-Absicherung: der Job liest alle aktiven Kalender inkrementell und erneuert Kanäle vor Ablauf', async () => {
  const { runKalendersyncJob } = require('../jobs/kalendersync');
  await verbunden();
  await waehlen(FEI, true);
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Per Job gelesen' }));
  g.fremdNeu(FEI, ganzEv(Z.addTage(WT, 1), Z.addTage(WT, 1), { summary: 'Per Job Feiertag' }));
  g.listen.length = 0;
  const alt = await quelle(FEI);
  await H.pool.query('UPDATE kalender_google_quellen SET channel_ablauf=$1 WHERE id=$2', [new Date(Date.now() + 3600 * 1000), alt.id]);
  const r = await runKalendersyncJob();
  await google._ruhe();
  assert.equal(r.status, 'ok');
  assert.deepEqual(await titel(), ['Per Job Feiertag', 'Per Job gelesen']);
  assert.ok(g.listen.every(l => l.syncToken), 'inkrementell');
  const neu = await quelle(FEI);
  assert.notEqual(neu.channel_id, alt.channel_id, 'Kanal erneuert');
  assert.ok(g.gestoppt.some(x => x.id === alt.channel_id), 'alter Kanal beendet');
  const nochmal = await quelle(PRIM);
  assert.ok(nochmal.channel_id, 'Kanal des Hauptkalenders bleibt');
});

test('Fehler pro Kalender: ein Kalender mit Fehler hält die anderen nicht auf, kein Geheimnis im Fehlertext', async () => {
  await verbunden();
  await waehlen(FEI, true);
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Läuft' }));
  const echt = g.fetch;
  GA._setHttp({ fetch: async (url, o) => (String(url).includes(encodeURIComponent(FEI)) && String(url).includes('/events?') ? { status: 403, ok: false, headers: { get: () => null }, json: async () => ({ error: { errors: [{ reason: 'forbidden' }] } }) } : echt(url, o)) });
  const r = await sync();
  assert.equal(r.ok, true);
  assert.deepEqual(await titel(), ['Läuft']);
  const q = await quelle(FEI);
  assert.match(q.fehler, /403/);
  assert.ok(q.fehler_seit);
  const liste = (await call('GET', '/api/kalender/google/quellen')).body.kalender;
  assert.ok(liste.find(k => k.name === 'Feiertage in der Schweiz').fehler);
  GA._setHttp({ fetch: g.fetch, sleep: g.sleep });
  await sync();
  assert.equal((await quelle(FEI)).fehler, null, 'Fehler verschwindet nach Erfolg');
});

test('Ein bei Google gelöschter Kalender (404) wird samt Terminen entfernt', async () => {
  await verbunden();
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00'));
  await sync();
  assert.equal((await termine()).length, 1);
  g.fremd.delete(PRIM); // Kalender existiert bei Google nicht mehr, steht aber noch in der gespeicherten Liste
  g.kalenderListe.splice(g.kalenderListe.findIndex(k => k.id === PRIM), 1);
  await sync();
  assert.equal(await quelle(PRIM), undefined);
  assert.deepEqual(await termine(), []);
});

// ── Datenschutz ──
test('Keine Teilnehmerlisten, Beschreibungen oder Organisatoren in der Datenbank, nur die Anzahl', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '10:00', '11:00', {
    summary: 'Strategie', description: 'GEHEIME BESCHREIBUNG mit Zahlen', organizer: { email: 'chefin@firma.ch', displayName: 'Chefin Muster' }, creator: { email: 'ersteller@firma.ch' },
    attendees: [{ email: 'anna.muster@kunde.ch', displayName: 'Anna Muster', responseStatus: 'accepted' }, { email: 'bob@kunde.ch', displayName: 'Bob Beispiel' }, { self: true, email: 'contact@lorenalienhard.ch', responseStatus: 'accepted' }],
    hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/abc' }] }
  }));
  await verbunden({ kalender: false });
  const rows = await termine();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].teilnehmer, 3);
  const alles = JSON.stringify(await H.pool.query('SELECT * FROM kalender_google_termine')) + JSON.stringify(await KD.quellenAlle(1));
  for (const verboten of ['anna.muster', 'Anna Muster', 'bob@', 'Bob Beispiel', 'chefin@', 'Chefin', 'ersteller@', 'GEHEIME', 'meet.google.com', 'contact@lorenalienhard.ch']) assert.ok(!alles.includes(verboten), 'nicht gespeichert: ' + verboten);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['advisor_id', 'beginn_min', 'datum_bis', 'datum_von', 'ende_min', 'frei', 'ganztaegig', 'google_id', 'id', 'link', 'ort', 'quelle_id', 'teilnehmer', 'titel']);
});

test('Titel und Orte stehen in keinem Log, Tokens und Google-Antworten bleiben geheim', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '10:00', '11:00', { summary: 'Scheidungsanwalt Besprechung', location: 'Praxis Dr. Geheim' }));
  g.fremdNeu(FEI, zeitEv(WT, '10:00', '11:00', { summary: 'Zweiter Geheimtermin' }));
  await verbunden({ kalender: false });
  await waehlen(FEI, true);
  g.gone410Fremd = true;
  await sync();
  await call('GET', '/api/kalender/google/quellen?abgleichen=1');
  await call('POST', '/api/kalender/google/trennen', {});
  const l = log.join('\n');
  assert.ok(!/Scheidungsanwalt|Praxis Dr|Geheimtermin/.test(l), 'Termindaten nie im Log');
  assert.ok(!l.includes(g.access) && !l.includes(g.refresh) && !l.includes(process.env.GOOGLE_CLIENT_SECRET), 'Tokens nie im Log');
});

test('Trennen löscht alle Daten der weiteren Kalender und beendet ihre Kanäle', async () => {
  await verbunden();
  await waehlen(FEI, true);
  g.fremdNeu(PRIM, zeitEv(WT, '09:00', '10:00', { summary: 'Löschen bitte' }));
  g.fremdNeu(FEI, ganzEv(WT, WT, { summary: 'Feiertag löschen' }));
  await sync();
  assert.equal((await termine()).length, 2);
  const kanaele = (await KD.quellenAlle(1)).map(q => q.channel_id).filter(Boolean);
  assert.equal(kanaele.length, 2);
  const r = await call('POST', '/api/kalender/google/trennen', {});
  assert.equal(r.body.ok, true);
  assert.deepEqual(await termine(), []);
  assert.deepEqual(await KD.quellenAlle(1), []);
  assert.equal(await KD.googleZeile(1), null);
  for (const k of kanaele) assert.ok(g.gestoppt.some(x => x.id === k), 'Kanal beendet: ' + k);
  assert.equal(g.widerrufen.length, 1, 'Token bei Google widerrufen');
  assert.deepEqual((await D.planFuer(1, WT)).bloecke, [], 'nichts mehr im Kalender');
});

// ── Rolle ──
test('Nur die Beraterin: Klienten und Anonyme sind abgewiesen', async () => {
  await verbunden();
  const kt = H.clientToken(klient.id);
  for (const [m, u] of [['GET', '/quellen'], ['PATCH', '/quellen/1']]) {
    assert.equal((await call(m, '/api/kalender/google' + u, { aktiv: true }, kt)).status, 403, m + u);
    assert.equal((await call(m, '/api/kalender/google' + u, { aktiv: true }, '')).status, 401, m + u);
  }
});

// ── Assistent ──
function planMitTerminen(bloecke, items = []) {
  return { datum: WT, arbeitstag: true, grund: null, bloecke, items, mittag: null, ende: items.length ? Z.hhmm(Math.max(...items.map(i => i.ende))) : null };
}
test('Assistent (Logik): «Was habe ich heute?» nennt Termine und Plan, «Wann habe ich Zeit?» freie Fenster, keine Gedankenstriche', () => {
  const jetzt = Z.zuDate(WT, 480);
  const plan = planMitTerminen([
    { titel: 'Ganzer Tag – Konferenz', ganztaegig: true, beginn: null, ende: null },
    { titel: 'Kundentermin', ganztaegig: false, beginn: 600, ende: 660, ort: 'Zürich' },
    { titel: 'Verfügbar', ganztaegig: false, beginn: 840, ende: 900, frei: true }
  ], [{ beginn: 480, ende: 500 }]);
  const t = AP.termineAntwort(plan, 'termine', { jetzt, heute: WT });
  assert.match(t, /^Heute hast du 3 Termine: ganztägig «Ganzer Tag, Konferenz»; 10:00 bis 11:00 Uhr «Kundentermin», Zürich; 14:00 bis 15:00 Uhr «Verfügbar» \(verfügbar\)\./);
  assert.match(t, /Im Plan steht eine Aufgabe, die letzte endet um 08:20 Uhr\./);
  assert.doesNotMatch(t, /[–—]/);
  const z = AP.termineAntwort(plan, 'zeit', { jetzt, heute: WT });
  assert.match(z, /^Heute hast du Zeit: 08:20 bis 10:00 Uhr, 11:00 bis 18:00 Uhr\.$/, 'Aufgabe und besetzter Termin ausgespart, «Verfügbar» sperrt nichts');
  assert.equal(AP.termineAntwort(planMitTerminen([]), 'termine', { jetzt, heute: WT }), 'Heute hast du keine Termine.');
  assert.match(AP.termineAntwort({ ...planMitTerminen([]), datum: Z.addTage(WT, 1) }, 'termine', { jetzt, heute: WT }), /^Morgen hast du keine Termine\.$/);
  const dicht = planMitTerminen([{ titel: 'Alles', ganztaegig: false, beginn: 480, ende: 1080 }]);
  assert.match(AP.termineAntwort(dicht, 'zeit', { jetzt, heute: WT }), /keine zusammenhängende freie Zeit/);
});
test('Assistent (Erkennung): termine_zeigen ist eine Aktion der festen Liste, Datum und Modus werden geprüft', () => {
  assert.ok(A.AKTIONEN.includes('termine_zeigen'));
  assert.deepEqual(A.pruefeAktion('{"aktion":"termine_zeigen"}', [], { heute: WT }), { type: 'termine_zeigen', datum: WT, modus: 'termine' });
  assert.deepEqual(A.pruefeAktion('{"aktion":"termine_zeigen","datum":"morgen","modus":"zeit"}', [], { heute: WT }), { type: 'termine_zeigen', datum: Z.addTage(WT, 1), modus: 'zeit' });
  assert.equal(A.pruefeAktion('{"aktion":"termine_zeigen","datum":"irgendwann","modus":"zeit"}', [], { heute: WT }).rueckfrage, true);
  assert.equal(A.pruefeAktion('{"aktion":"termine_zeigen","modus":"loeschen"}', [], { heute: WT }).modus, 'termine');
  assert.match(A.baueSystem('Hilfe', new Date()), /termine_zeigen/);
});
test('Assistent (Route): Termine stammen aus dem Kalender, die KI sieht nur die Frage und nie Titel, Orte oder Zeiten', async () => {
  konto();
  g.fremdNeu(PRIM, zeitEv(WT, '10:00', '11:00', { summary: 'Mandat Huber', location: 'Kanzlei Seestrasse' }));
  await verbunden({ kalender: false });
  H.ai.calls.length = 0;
  H.ai.reply = JSON.stringify({ aktion: 'termine_zeigen', datum: WT, modus: 'termine' }); H.ai.fail = false;
  const r = await call('POST', '/api/assistent/befehl', { text: `Was habe ich am ${WT}?` });
  assert.equal(r.status, 200);
  assert.equal(r.body.aktion.type, 'answer');
  assert.match(r.body.aktion.text, /10:00 bis 11:00 Uhr «Mandat Huber», Kanzlei Seestrasse/);
  assert.equal(r.body.antwort, r.body.aktion.text);
  assert.equal(H.ai.calls.length, 1, 'genau ein KI-Aufruf: die normale Befehlserkennung');
  const prompt = JSON.stringify(H.ai.calls[0]);
  assert.ok(!/Mandat Huber|Kanzlei Seestrasse/.test(prompt), 'keine Termindaten im Auftrag an die KI');
  // freie Zeit
  H.ai.reply = JSON.stringify({ aktion: 'termine_zeigen', datum: WT, modus: 'zeit' });
  const z = await call('POST', '/api/assistent/befehl', { text: 'Wann habe ich Zeit?' });
  assert.match(z.body.aktion.text, /hast du Zeit: .*10:00/);
  assert.ok(!/Mandat Huber/.test(JSON.stringify(H.ai.calls[1])));
});

// ── Oberfläche ──
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };
test('Oberfläche: Hinweis, Knopf, Auswahl mit Haken und Farbe, Details mit «In Google öffnen», Texte, Paare, alle Script-Blöcke gültig', () => {
  const ks = block('rq-kalendersync-js'), tp = block('rq-tagesplan-js');
  for (const t of ['Für die Anzeige deiner übrigen Termine ist eine zusätzliche Freigabe nötig', 'Erneut mit Google verbinden', 'Weitere Google-Kalender (nur lesen)', "type:'checkbox'", "type:'color'",
    '/api/kalender/google/quellen', 'zusatzFreigabeNoetig', 'Datenschutz: RhetorIQ speichert von diesen Terminen', 'Hauptkalender']) assert.ok(ks.includes(t), 'fehlt in rq-kalendersync-js: ' + t);
  for (const t of ['oeffneGoogle', 'In Google öffnen', 'Teilnehmende: ', 'nur zum Lesen', 'Verfügbar', 'noopener noreferrer', "/^https:\\/\\//i"]) assert.ok(tp.includes(t), 'fehlt in rq-tagesplan-js: ' + t);
  assert.ok(html.includes('.tp-b.fremd.frei{') && html.includes('button.tp-ban.fremd{'));
  const m = /<script id="rq-xpairs-tagesplan">([\s\S]*?)<\/script>/.exec(html);
  const win = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(m[1], { window: win });
  const de = new Set(win.RQ_EXTRA_PAIRS.map(p => p[0]));
  for (const t of ['Weitere Google-Kalender (nur lesen)', 'Für die Anzeige deiner übrigen Termine ist eine zusätzliche Freigabe nötig.', 'Erneut mit Google verbinden', 'In Google öffnen', 'Termin aus Google',
    'Dein Google-Konto hat keine weiteren Kalender.']) assert.ok(de.has(t), 'Paar fehlt: ' + t);
  // Schreibregeln für die neuen Texte
  const neu = win.RQ_EXTRA_PAIRS.filter(p => /Google-Kalender|Freigabe|In Google/.test(p[0])).map(p => p[0]).join(' ');
  assert.doesNotMatch(neu, /[–—]/);
  assert.doesNotMatch(neu, /ß/);
  assert.doesNotMatch(neu, /\bnicht\b[^.]{0,60}\bsondern\b/);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let mm;
  while ((mm = re.exec(html))) { if (/src=/.test(mm[1])) continue; assert.doesNotThrow(() => new vm.Script(mm[2]), 'Syntaxfehler in ' + ((/id="([^"]+)"/.exec(mm[1]) || [])[1] || 'Block')); }
});
