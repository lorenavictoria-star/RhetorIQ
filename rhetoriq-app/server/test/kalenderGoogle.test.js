// Google Kalender: OAuth, Schreiben, Lesen, Webhook, Rückmeldungsregeln, Echo-Schutz, Kanäle, Trennen. Alles mit gemockter Google-API.
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test-geheimnis-12345678';
process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { fakeGoogle } = require('../test-support/fakeGoogle');
const Z = require('../lib/zeit');
const D = require('../lib/tagesplanDaten');
const KD = require('../lib/kalendersync/daten');
const GA = require('../lib/kalendersync/googleApi');
const google = require('../lib/kalendersync/google');
const secretBox = require('../lib/secretBox');
const { scrubText } = require('../lib/scrub');

let srv, g, klient;
const log = [];
for (const k of ['log', 'error', 'warn', 'info']) { const o = console[k]; console[k] = (...a) => { log.push(a.map(String).join(' ')); if (process.env.KS_DEBUG) o(...a); }; }
const adv = () => H.advisorToken();
const heute = Z.heute();
const tag = (n) => Z.addTage(heute, n);
const call = (m, u, body, token = adv()) => srv.call(m, u, { token, body: m === 'GET' ? undefined : body });

async function zuruecksetzen() {
  for (const t of ['kalender_google', 'kalender_google_state', 'kalender_google_map', 'kalender_ausgeblendet', 'kalender_fremd', 'tagesplan_eintraege', 'tagesplan_positionen', 'review_requests']) await H.pool.query(`DELETE FROM ${t}`);
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
  await require('../lib/schemaRedesign').ensureSchema();
  await D.ensureSchema();
  klient = await H.addClient('Muster AG');
  srv = await H.startApp([['/api/tagesplan', require('../routes/tagesplan')], ['/api/kalender/google', require('../routes/kalenderGoogle')], ['/api/kalender/fremd', require('../routes/kalenderFremd')]]);
});
test.after(async () => { await srv.close(); });
test.beforeEach(zuruecksetzen);

// Verbindung über die echten Routen herstellen
async function verbinden() {
  const r = await call('POST', '/api/kalender/google/verbinden', {}, adv()).then(() => null);
  return r;
}
async function oauth({ code = 'gute-code', stateAendern, cookieAendern } = {}) {
  const raw = await srv.call('POST', '/api/kalender/google/verbinden', { token: adv(), body: {}, raw: true });
  const j = await raw.json();
  const u = new URL(j.url);
  const cookie = (raw.headers.get('set-cookie') || '').split(';')[0];
  const state = stateAendern ? stateAendern(u.searchParams.get('state')) : u.searchParams.get('state');
  const r = await fetch(`${srv.base}/api/kalender/google/callback?code=${code}&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: cookieAendern ? cookieAendern(cookie) : cookie } });
  return { status: r.status, ort: r.headers.get('location'), url: u, state: u.searchParams.get('state'), cookie };
}
// Schnelle Verbindung ohne Umweg über den Browser (der Ablauf über die Routen ist in den OAuth-Tests abgedeckt)
async function verbunden() {
  await google.verbindungHerstellen(1, 'gute-code', 'verifier-fuer-test');
  await google.synchronisiere(1, { voll: true });
  await google._ruhe();
}
const termin = (o = {}) => ({ titel: 'Workshop', typ: 'kunde', datum: tag(2), beginn: '10:00', ende: '11:30', ...o });
const gw = (re) => g.log.filter(l => re.test(l.methode + ' ' + l.pfad));

// ── OAuth ──
test('Ohne Zugangsdaten meldet die Oberfläche «Google-Zugang ist noch nicht eingerichtet»', async () => {
  const id = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const st = await call('GET', '/api/kalender/google/status');
    assert.equal(st.body.konfiguriert, false);
    assert.match(st.body.hinweis, /Google-Zugang ist noch nicht eingerichtet/);
    const v = await call('POST', '/api/kalender/google/verbinden', {});
    assert.equal(v.status, 503);
    assert.match(v.body.error, /Google-Zugang ist noch nicht eingerichtet/);
    assert.match(v.body.hinweis, /GOOGLE_CLIENT_ID/);
  } finally { process.env.GOOGLE_CLIENT_ID = id; }
});

test('Ohne Verschlüsselungsschlüssel wird nichts gespeichert und klar gemeldet', async () => {
  const k = process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  try {
    const v = await call('POST', '/api/kalender/google/verbinden', {});
    assert.equal(v.status, 503);
    assert.match(v.body.error, /Verschlüsselung/);
    assert.equal((await H.pool.query('SELECT 1 FROM kalender_google_state')).rows.length, 0);
    assert.equal((await call('GET', '/api/kalender/google/status')).body.schluesselOk, false);
    // Auch ein direkter Versuch, ein Token zu speichern, scheitert ohne Schlüssel
    await assert.rejects(() => google.verbindungHerstellen(1, 'gute-code', 'v'), /Verschlüsselung/);
    assert.equal((await H.pool.query('SELECT 1 FROM kalender_google')).rows.length, 0);
  } finally { process.env.SECRETS_ENCRYPTION_KEY = k; }
});

test('Autorisierungsadresse: Scope, offline, Zustimmung, state, PKCE, genaue Weiterleitung', async () => {
  const r = await call('POST', '/api/kalender/google/verbinden', {});
  const u = new URL(r.body.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.app.created');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.test/api/kalender/google/callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('state').length >= 40 && u.searchParams.get('code_challenge').length >= 40);
  assert.ok(!u.search.includes(process.env.GOOGLE_CLIENT_SECRET), 'Geheimnis nie in der Adresse');
  const r2 = await call('POST', '/api/kalender/google/verbinden', {});
  assert.notEqual(new URL(r2.body.url).searchParams.get('state'), u.searchParams.get('state'), 'state ist zufällig');
});

test('state ist einmalig, falscher state und fremder Browser werden abgelehnt', async () => {
  const falsch = await oauth({ stateAendern: () => 'erfunden' });
  assert.match(falsch.ort, /google=zustand/);
  assert.equal(await KD.googleZeile(1), null);
  const fremderBrowser = await oauth({ cookieAendern: () => 'rq_gs=anderer' });
  assert.match(fremderBrowser.ort, /google=zustand/);
  assert.equal(await KD.googleZeile(1), null, 'ohne passenden Browser keine Verbindung');
  const gut = await oauth();
  assert.match(gut.ort, /google=verbunden/);
  await google._ruhe();
  // gleicher state noch einmal
  const nochmal = await fetch(`${srv.base}/api/kalender/google/callback?code=gute-code&state=${encodeURIComponent(gut.state)}`, { redirect: 'manual', headers: { cookie: gut.cookie } });
  assert.match(nochmal.headers.get('location'), /google=zustand/);
  // abgelaufener state
  await KD.stateAnlegen(1, 'alt', 'b', secretBox.encrypt('v'), -1);
  assert.equal(await KD.stateEinloesen('alt', 'b'), null);
});

test('Verbinden: Kalender «RhetorIQ» wird angelegt, das Refresh-Token liegt nur verschlüsselt in der Datenbank', async () => {
  await verbunden();
  assert.equal(g.kalender.summary, 'RhetorIQ');
  const row = await KD.googleZeile(1);
  assert.equal(row.calendar_id, g.kalender.id);
  assert.ok(row.refresh_enc.startsWith('v1.'));
  assert.ok(!row.refresh_enc.includes(g.refresh));
  assert.equal(secretBox.decrypt(row.refresh_enc), g.refresh);
  const st = await call('GET', '/api/kalender/google/status');
  assert.equal(st.body.verbunden, true);
  assert.ok(!JSON.stringify(st.body).includes(g.refresh) && !JSON.stringify(st.body).includes(g.access));
  assert.equal(g.tokenAnfragen[0].client_secret, process.env.GOOGLE_CLIENT_SECRET, 'wird an Google gesendet');
  assert.ok(g.tokenAnfragen[0].code_verifier, 'PKCE');
});

test('Token und Geheimnis stehen nie in Logs, Antworten oder Fehlertexten', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  g.serverFehler = 50;
  const s = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(s.body.ok, false);
  const alles = log.join('\n') + JSON.stringify(s.body) + JSON.stringify((await call('GET', '/api/kalender/google/status')).body);
  for (const geheim of [g.refresh, g.access, process.env.GOOGLE_CLIENT_SECRET, 'gute-code']) assert.ok(!alles.includes(geheim), 'Geheimnis in Ausgabe: ' + geheim.slice(0, 6));
  const row = await KD.googleZeile(1);
  assert.ok(!String(row.fehler).includes(g.access));
  // Sentry-Filter und Fehlerbereinigung kennen Googles Tokenformate
  assert.ok(!scrubText(`Fehler ${g.access} und ${g.refresh} und ${process.env.GOOGLE_CLIENT_SECRET}`).match(/ya29|1\/\/refresh|GOCSPX/));
  assert.ok(!GA.sauber(`x client_secret=${process.env.GOOGLE_CLIENT_SECRET}`).includes('GOCSPX-test'));
});

test('Fehlender Dauerzugriff (kein Refresh-Token) oder abgelehnte Berechtigung speichern nichts', async () => {
  g.ohneRefresh = true;
  const a = await oauth();
  assert.match(a.ort, /google=dauerzugriff/);
  assert.equal(await KD.googleZeile(1), null);
  g.ohneRefresh = false; g.scope = 'openid';
  const b = await oauth();
  assert.match(b.ort, /google=berechtigung/);
  assert.equal(await KD.googleZeile(1), null);
  g.scope = 'https://www.googleapis.com/auth/calendar.app.created';
  const r = await call('POST', '/api/kalender/google/verbinden', {});
  const state = new URL(r.body.url).searchParams.get('state');
  const x = await fetch(`${srv.base}/api/kalender/google/callback?error=access_denied&state=${state}`, { redirect: 'manual' });
  assert.match(x.headers.get('location'), /google=zustand|google=abgelehnt/);
});

test('Nur die Beraterin: Klient, ohne Anmeldung und Webhook-Rolle', async () => {
  const kt = H.clientToken(klient.id);
  for (const [m, u] of [['GET', '/status'], ['POST', '/verbinden'], ['POST', '/sync'], ['POST', '/trennen'], ['DELETE', '/ausgeblendet']]) {
    assert.equal((await call(m, '/api/kalender/google' + u, {}, kt)).status, 403, m + u);
    assert.equal((await call(m, '/api/kalender/google' + u, {}, '')).status, 401, m + u);
  }
  for (const [m, u] of [['GET', ''], ['POST', ''], ['POST', '/abrufen'], ['DELETE', '/1'], ['PATCH', '/1']]) assert.equal((await call(m, '/api/kalender/fremd' + u, {}, kt)).status, 403, 'fremd ' + m + u);
  assert.equal((await call('GET', '/api/kalender/fremd', undefined, '')).status, 401);
});

// ── Schreiben ──
test('Termin anlegen, ändern, löschen: Ereignis mit Verknüpfung, Farbe und Herkunftskennung', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', termin());
  assert.equal(c.status, 201);
  assert.equal(g.aktive().length, 0, 'gebündelt: noch nichts gesendet');
  await google._ruhe();
  const evs = g.aktive();
  assert.equal(evs.length, 1);
  const e = evs[0];
  assert.equal(e.summary, 'Workshop');
  assert.equal(e.start.dateTime, `${tag(2)}T10:00:00`);
  assert.equal(e.start.timeZone, 'Europe/Zurich');
  assert.equal(e.end.dateTime, `${tag(2)}T11:30:00`);
  assert.equal(e.colorId, '9', 'Kundentermin: nächstliegende Google-Farbe');
  assert.equal(e.extendedProperties.private.rqHerkunft, 'rhetoriq');
  assert.equal(e.extendedProperties.private.rqUid, `rq-e${c.body.id}-${tag(2)}@rhetoriq.ch`);
  const map = await KD.mapHole(1, `rq-e${c.body.id}-${tag(2)}@rhetoriq.ch`);
  assert.equal(map.google_id, e.id);
  assert.equal(map.eintrag_id, c.body.id);
  assert.equal(map.etag, e.etag);
  // ändern
  await call('PUT', `/api/tagesplan/termine/${c.body.id}`, termin({ titel: 'Workshop Neu', beginn: '14:00', ende: '15:00' }));
  await google._ruhe();
  assert.equal(g.aktive().length, 1);
  assert.equal(g.aktive()[0].summary, 'Workshop Neu');
  assert.equal(g.aktive()[0].start.dateTime, `${tag(2)}T14:00:00`);
  assert.equal(gw(/^PATCH/).length, 1, 'Änderung als Update, nicht als neues Ereignis');
  // löschen
  await call('DELETE', `/api/tagesplan/termine/${c.body.id}`);
  await google._ruhe();
  assert.equal(g.aktive().length, 0);
  assert.equal(await KD.mapHole(1, `rq-e${c.body.id}-${tag(2)}@rhetoriq.ch`), null);
});

test('Entprellung: viele Änderungen in kurzer Zeit führen zu einem einzigen Abgleich', async () => {
  await verbunden();
  const vorher = google.statistik.laeufe;
  for (let i = 0; i < 4; i++) await call('POST', '/api/tagesplan/termine', termin({ titel: 'T' + i, datum: tag(3 + i) }));
  await google._ruhe();
  assert.equal(google.statistik.laeufe - vorher, 1);
  assert.equal(g.aktive().length, 4);
});

test('Wiederkehrende Termine werden für 60 Tage als einzelne Ereignisse geschrieben', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', { titel: 'Team', typ: 'termin', datum: tag(1), beginn: '09:00', ende: '09:30', wiederholung: 'taeglich', bis: tag(100) });
  assert.equal(c.status, 201);
  await google._ruhe();
  const evs = g.aktive();
  assert.ok(evs.length >= 59 && evs.length <= 62, 'Anzahl ' + evs.length);
  assert.equal(new Set(evs.map(e => e.id)).size, evs.length);
  assert.ok(evs.every(e => e.start.dateTime <= `${tag(61)}T23:59:59`));
  // Serie löschen entfernt alle Vorkommen
  await call('DELETE', `/api/tagesplan/termine/${c.body.id}`);
  await google._ruhe();
  assert.equal(g.aktive().length, 0);
});

test('Ganztägige Einträge (Ferien) als Tagesereignis ohne Uhrzeit', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', { titel: 'Ferien', typ: 'ferien', datum: tag(5), bis: tag(6), wiederholung: 'taeglich' });
  await google._ruhe();
  const evs = g.aktive();
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map(e => e.start.date).sort(), [tag(5), tag(6)]);
  assert.equal(evs[0].end.date, Z.addTage(evs[0].start.date, 1));
});

test('Aufgabenblöcke enthalten nur Klientenname, Textart, Frist und Link', async () => {
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','GEHEIMER KLIENTENTEXT', TRUE)`, [klient.id]);
  await verbunden();
  await google.synchronisiere(1);
  const task = g.aktive().find(e => e.extendedProperties.private.rqArt === 'task');
  assert.ok(task, 'Aufgabe im Kalender');
  assert.match(task.summary, /Muster AG/);
  assert.match(task.description, /Klient: Muster AG/);
  assert.match(task.description, /Textart: Newsletter/);
  assert.match(task.description, /Link: https:\/\/app\.test\/#ws=/);
  assert.ok(!JSON.stringify(task).includes('GEHEIMER'));
  assert.equal(task.source.url.startsWith('https://app.test/'), true);
  await H.pool.query('DELETE FROM review_requests');
});

test('Retry: Limit 429 und Serverfehler werden mit wachsendem Abstand wiederholt', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', termin());
  g.rate429 = 2;
  await google._ruhe();
  assert.equal(g.aktive().length, 1, 'trotz zweimal 429 angelegt');
  assert.ok(g.sleeps.length >= 2);
  assert.ok(g.sleeps.every(ms => ms <= 60000));
  // Dauerhafter Fehler: Fehler wird festgehalten, später gelingt es
  g.sleeps.length = 0;
  await call('POST', '/api/tagesplan/termine', termin({ titel: 'Zweiter' }));
  g.serverFehler = 7; // erster Lauf (5 Versuche) scheitert, der Wiederholungslauf gelingt
  await google._ruhe();
  assert.equal(g.aktive().length, 2);
  const row = await KD.googleZeile(1);
  assert.equal(row.fehler, null, 'Fehler nach Erfolg gelöscht');
});

test('Dauerhafter Fehler wird der Beraterin angezeigt, ohne Geheimnisse', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', termin());
  g.serverFehler = 100000;
  const s = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(s.body.ok, false);
  const st = (await call('GET', '/api/kalender/google/status')).body;
  assert.match(st.fehler, /Status 503/);
  assert.ok(st.fehlerSeit);
  g.serverFehler = 0;
  await google._ruhe();
  const s2 = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(s2.body.ok, true);
  assert.equal((await call('GET', '/api/kalender/google/status')).body.fehler, null);
});

// ── Lesen: Webhook, syncToken ──
async function kanalHolen() {
  const k = await google.kanalSicherstellen(1);
  assert.equal(k.ok, true);
  const k0 = g.kanaele[g.kanaele.length - 1];
  return { id: k0.id, token: k0.token };
}
const webhook = (id, token, zustand = 'exists') => fetch(`${srv.base}/api/kalender/google/webhook`, { method: 'POST', headers: { 'X-Goog-Channel-ID': id || '', 'X-Goog-Channel-Token': token || '', 'X-Goog-Resource-State': zustand } });

test('Webhook: nur mit gültiger Kanal-ID und gültigem Kanal-Token, Hash gespeichert', async () => {
  await verbunden();
  const { id, token } = await kanalHolen();
  const row = await KD.googleZeile(1);
  assert.equal(row.channel_id, id);
  assert.notEqual(row.channel_token_hash, token);
  assert.equal(row.channel_token_hash, KD.sha(token));
  assert.ok(!JSON.stringify(row).includes(token), 'Geheimnis nicht im Klartext gespeichert');
  assert.equal(g.kanaele[0].address, 'https://app.test/api/kalender/google/webhook');
  assert.equal((await webhook(id, 'falsch')).status, 404);
  assert.equal((await webhook(id, '')).status, 404);
  assert.equal((await webhook('anderer-kanal', token)).status, 404);
  assert.equal((await webhook('', '')).status, 404);
  g.listen.length = 0;
  assert.equal((await webhook(id, 'falsch')).status, 404);
  await google._ruhe();
  assert.equal(g.listen.length, 0, 'falsches Token löst keinen Abgleich aus');
  // sync: Bestätigung beim Anlegen, kein Abgleich
  assert.equal((await webhook(id, token, 'sync')).status, 200);
  await google._ruhe();
  assert.equal(g.listen.length, 0);
});

test('Webhook exists löst die inkrementelle Abfrage aus, Änderung vom Handy kommt an', async () => {
  await verbunden();
  const { id, token } = await kanalHolen();
  await google.synchronisiere(1); // Sync-Token holen
  g.listen.length = 0;
  g.handyNeu({ summary: 'Zahnarzt', start: { dateTime: `${tag(2)}T08:00:00+02:00` }, end: { dateTime: `${tag(2)}T09:00:00+02:00` } });
  assert.equal((await webhook(id, token)).status, 200);
  await google._ruhe();
  assert.ok(g.listen.length >= 1);
  assert.ok(g.listen[0].syncToken, 'inkrementell mit syncToken');
  const t = (await D.eintraege(1)).find(e => e.titel === 'Zahnarzt');
  assert.ok(t, 'neuer Termin in RhetorIQ');
  assert.equal(t.typ, 'termin');
});

test('syncToken: erst voll, dann inkrementell; bei 410 volle Neusynchronisation', async () => {
  await verbunden();
  g.listen.length = 0;
  await google.synchronisiere(1, { voll: true });
  assert.equal(g.listen[0].syncToken, undefined);
  const row = await KD.googleZeile(1);
  assert.match(row.sync_token, /^st\d+$/);
  g.listen.length = 0;
  await google.synchronisiere(1);
  assert.ok(g.listen[0].syncToken);
  g.listen.length = 0;
  g.gone410 = true;
  g.handyNeu({ summary: 'Nach 410', start: { dateTime: `${tag(4)}T08:00:00+02:00` }, end: { dateTime: `${tag(4)}T09:00:00+02:00` } });
  const r = await google.synchronisiere(1);
  assert.equal(r.ok, true);
  assert.ok(g.listen[0].syncToken, 'erster Versuch mit Token');
  assert.equal(g.listen[1].syncToken, undefined, 'danach vollständig ohne Token');
  assert.ok((await D.eintraege(1)).some(e => e.titel === 'Nach 410'));
  assert.match((await KD.googleZeile(1)).sync_token, /^st\d+$/);
});

test('Mehrere Seiten werden abgeholt', async () => {
  await verbunden();
  g.seitenGroesse = 2;
  for (let i = 0; i < 5; i++) g.handyNeu({ summary: 'S' + i, start: { dateTime: `${tag(2 + i)}T08:00:00+02:00` }, end: { dateTime: `${tag(2 + i)}T09:00:00+02:00` } });
  await google.synchronisiere(1, { voll: true });
  assert.equal((await D.eintraege(1)).filter(e => /^S\d$/.test(e.titel)).length, 5);
});

// ── Rückmeldungsregeln ──
test('Neu am Handy angelegt: wird zum Termin vom Typ Termin und danach mit Herkunft und Farbe ergänzt', async () => {
  await verbunden();
  const hid = g.handyNeu({ summary: 'Mittagessen mit Anna', description: 'Bei Giovanni', start: { dateTime: `${tag(3)}T12:30:00+02:00` }, end: { dateTime: `${tag(3)}T13:30:00+02:00` } });
  await google.synchronisiere(1);
  const t = (await D.eintraege(1)).find(e => e.titel === 'Mittagessen mit Anna');
  assert.ok(t);
  assert.equal(t.typ, 'termin');
  assert.equal(t.datum, tag(3));
  const sommer = Z.zurich(new Date(`${tag(3)}T12:30:00+02:00`));
  assert.equal(t.beginn, sommer.min);
  assert.equal(t.ende - t.beginn, 60);
  assert.equal(t.notiz, 'Bei Giovanni');
  const ev = g.ereignisse.get(hid);
  assert.equal(ev.extendedProperties.private.rqHerkunft, 'rhetoriq', 'Herkunft nachgetragen');
  assert.equal(g.aktive().length, 1, 'kein Duplikat');
  const map = await KD.mapNachGoogleId(1, hid);
  assert.equal(map.eintrag_id, t.id);
});

test('Ganztägige Mehrtagesereignisse vom Handy werden zu einer Tagesserie und einzeln zurückgeschrieben', async () => {
  await verbunden();
  const hid = g.handyNeu({ summary: 'Kongress', start: { date: tag(4) }, end: { date: tag(7) } });
  await google.synchronisiere(1);
  const t = (await D.eintraege(1)).find(e => e.titel === 'Kongress');
  assert.equal(t.wiederholung, 'taeglich');
  assert.equal(t.bis, tag(6));
  assert.equal(g.ereignisse.get(hid).status, 'cancelled', 'Sammelereignis ersetzt');
  const tage = g.aktive().map(e => e.start.date).sort();
  assert.deepEqual(tage, [tag(4), tag(5), tag(6)]);
});

test('Verschoben oder in der Dauer geändert am Handy: Termin wird aktualisiert', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  const hid = g.aktive()[0].id;
  g.handyAendern(hid, { start: { dateTime: `${tag(3)}T15:00:00+02:00` }, end: { dateTime: `${tag(3)}T17:00:00+02:00` } });
  await google.synchronisiere(1);
  const t = (await D.eintraege(1)).find(e => e.id === c.body.id);
  assert.equal(t.datum, tag(3));
  assert.equal(t.ende - t.beginn, 120);
  assert.equal(t.titel, 'Workshop');
  assert.equal((await D.eintraege(1)).length, 1);
  assert.equal(g.aktive().length, 1);
  const map = await KD.mapNachGoogleId(1, hid);
  assert.equal(map.datum, tag(3));
  assert.equal(map.uid, `rq-e${c.body.id}-${tag(3)}@rhetoriq.ch`);
});

test('Gelöscht am Handy: Termin wird gelöscht, bei einer Serie nur das eine Vorkommen', async () => {
  await verbunden();
  const e1 = await call('POST', '/api/tagesplan/termine', termin({ titel: 'Einzeln' }));
  const serie = await call('POST', '/api/tagesplan/termine', { titel: 'Serie', typ: 'termin', datum: tag(1), beginn: '07:30', ende: '08:00', wiederholung: 'taeglich', bis: tag(10) });
  await google._ruhe();
  const einzelnId = g.aktive().find(e => e.summary === 'Einzeln').id;
  const serieEv = g.aktive().find(e => e.summary === 'Serie' && e.start.dateTime.startsWith(tag(3)));
  g.handyLoeschen(einzelnId);
  g.handyLoeschen(serieEv.id);
  await google.synchronisiere(1);
  const alle = await D.eintraege(1);
  assert.ok(!alle.find(e => e.id === e1.body.id), 'Einzeltermin gelöscht');
  const s = alle.find(e => e.id === serie.body.id);
  assert.ok(s, 'Serie bleibt');
  assert.deepEqual(s.ausnahmen, [tag(3)]);
  assert.equal(T().vorkommen(s, tag(3)), false);
  assert.equal(T().vorkommen(s, tag(4)), true);
  const plan = await D.planFuer(1, tag(3));
  assert.ok(!plan.bloecke.some(b => b.titel === 'Serie'));
  // und nach dem nächsten Schreiben ist das Vorkommen nicht wieder da
  await google.synchronisiere(1);
  assert.ok(!g.aktive().some(e => e.summary === 'Serie' && e.start.dateTime.startsWith(tag(3))));
});
const T = () => require('../lib/tagesplan');

test('Verschobene Serien-Vorkommen werden zu einem einzelnen Termin, die Serie lässt den Tag aus', async () => {
  await verbunden();
  const serie = await call('POST', '/api/tagesplan/termine', { titel: 'Serie', typ: 'sport', datum: tag(1), beginn: '07:30', ende: '08:00', wiederholung: 'taeglich', bis: tag(10) });
  await google._ruhe();
  const ev = g.aktive().find(e => e.start.dateTime.startsWith(tag(4)));
  g.handyAendern(ev.id, { start: { dateTime: `${tag(4)}T18:00:00+02:00` }, end: { dateTime: `${tag(4)}T19:00:00+02:00` } });
  await google.synchronisiere(1);
  const alle = await D.eintraege(1);
  assert.equal(alle.length, 2);
  const einzel = alle.find(e => e.wiederholung === 'keine');
  assert.equal(einzel.datum, tag(4));
  assert.equal(einzel.typ, 'sport');
  assert.deepEqual(alle.find(e => e.id === serie.body.id).ausnahmen, [tag(4)]);
  const heuteEvs = g.aktive().filter(e => e.start.dateTime.startsWith(tag(4)));
  assert.equal(heuteEvs.length, 1, 'genau ein Ereignis an diesem Tag');
});

async function aufgabeAnlegen(label = 'Newsletter') {
  await H.pool.query('DELETE FROM review_requests');
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,$2,'newsletter','x', TRUE)`, [klient.id, label]);
  await verbunden();
  await google.synchronisiere(1);
  return g.aktive().find(e => e.extendedProperties.private.rqArt === 'task');
}

test('Plan-Block am Handy verschoben oder verlängert: tagesplan_positionen wird aktualisiert, der Plan plant darum herum', async () => {
  const task = await aufgabeAnlegen();
  const key = task.extendedProperties.private.rqKey;
  g.handyAendern(task.id, { start: { dateTime: `${heute}T16:00:00+02:00` }, end: { dateTime: `${heute}T17:15:00+02:00` } });
  await google.synchronisiere(1);
  const pos = (await D.positionen(1))[key];
  assert.ok(pos, 'Position gespeichert');
  assert.equal(pos.datum, Z.zurich(new Date(`${heute}T16:00:00+02:00`)).datum);
  assert.equal(pos.beginn, Z.zurich(new Date(`${heute}T16:00:00+02:00`)).min);
  assert.equal(pos.dauer, 75);
  const plan = await D.planFuer(1, pos.datum);
  const item = plan.items.find(i => i.key === key);
  assert.equal(item.beginn, pos.beginn);
  assert.equal(item.ende - item.beginn, 75);
  assert.equal(item.fixiert, true);
  // zurückgeschrieben wird derselbe Zeitraum, keine Schleife
  const vor = g.schreibaufrufe().length;
  await google.synchronisiere(1);
  await google.synchronisiere(1);
  assert.ok(g.schreibaufrufe().length - vor <= 1, 'höchstens ein Angleichen, dann Ruhe');
  const stabil = g.schreibaufrufe().length;
  await google.synchronisiere(1);
  assert.equal(g.schreibaufrufe().length, stabil);
});

test('Plan-Aufgabe am Handy gelöscht: für den Tag ausgeblendet, die Aufgabe selbst bleibt', async () => {
  const task = await aufgabeAnlegen();
  const key = task.extendedProperties.private.rqKey;
  g.handyLoeschen(task.id);
  await google.synchronisiere(1);
  assert.equal((await KD.ausgeblendetAm(1, task.extendedProperties.private.rqUid ? heute : heute)).has(key) || (await H.pool.query('SELECT task_key FROM kalender_ausgeblendet')).rows.some(r => r.task_key === key), true);
  const plan = await D.planFuer(1, heute);
  assert.ok(!plan.items.some(i => i.key === key), 'nicht im Plan');
  assert.equal(plan.ausgeblendet >= 1, true);
  const r = (await H.pool.query(`SELECT status FROM review_requests WHERE module_label='Newsletter'`)).rows;
  assert.equal(r.length, 1, 'Aufgabe nicht gelöscht');
  assert.equal(r[0].status, 'pending');
  await google.synchronisiere(1);
  assert.ok(!g.aktive().some(e => e.extendedProperties.private.rqKey === key), 'nicht wieder angelegt');
  // wieder einblenden
  const w = await call('DELETE', '/api/kalender/google/ausgeblendet');
  assert.equal(w.body.eingeblendet >= 1, true);
  assert.ok((await D.planFuer(1, heute)).items.some(i => i.key === key));
});

test('Gleichzeitige Änderung: die neuere gilt (updated-Zeitstempel)', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  const hid = g.aktive()[0].id;
  // Handy-Änderung ist älter als die lokale Änderung
  await new Promise(r => setTimeout(r, 30));
  await call('PUT', `/api/tagesplan/termine/${c.body.id}`, termin({ titel: 'Lokal neuer', beginn: '09:00', ende: '10:00' }));
  g.handyAendern(hid, { start: { dateTime: `${tag(2)}T20:00:00+02:00` }, end: { dateTime: `${tag(2)}T21:00:00+02:00` }, summary: 'Handy alt' }, new Date(Date.now() - 60000).toISOString());
  await google._ruhe();
  await google.synchronisiere(1);
  const t = (await D.eintraege(1))[0];
  assert.equal(t.titel, 'Lokal neuer');
  assert.equal(g.ereignisse.get(hid).summary, 'Lokal neuer', 'Google bekommt den neueren Stand');
  // Handy-Änderung ist neuer
  g.handyAendern(hid, { summary: 'Handy neuer', start: { dateTime: `${tag(2)}T11:00:00+02:00` }, end: { dateTime: `${tag(2)}T12:00:00+02:00` } }, new Date(Date.now() + 60000).toISOString());
  await google.synchronisiere(1);
  const t2 = (await D.eintraege(1))[0];
  assert.equal(t2.titel, 'Handy neuer');
});

test('Lokal neuer gilt auch beim Löschen am Handy: der Termin wird wieder angelegt', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  const hid = g.aktive()[0].id;
  await new Promise(r => setTimeout(r, 30));
  await call('PUT', `/api/tagesplan/termine/${c.body.id}`, termin({ titel: 'Behalten' }));
  g.handyLoeschen(hid, new Date(Date.now() - 60000).toISOString());
  await google._ruhe();
  await google.synchronisiere(1);
  assert.equal((await D.eintraege(1)).length, 1);
  assert.equal(g.aktive().length, 1);
  assert.equal(g.aktive()[0].summary, 'Behalten');
});

// ── Echo ──
test('Echo-Schleifen: eigene Änderungen werden nicht zurückgespielt', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', termin());
  await call('POST', '/api/tagesplan/termine', { titel: 'Serie', typ: 'termin', datum: tag(1), beginn: '08:00', ende: '08:30', wiederholung: 'woechentlich', wochentage: [1, 2, 3, 4, 5], bis: tag(30) });
  await H.pool.query('DELETE FROM review_requests');
  await H.pool.query(`INSERT INTO review_requests (client_id, module_label, module_key, original_text, dringlich) VALUES ($1,'Newsletter','newsletter','x', TRUE)`, [klient.id]);
  await google._ruhe();
  await google.synchronisiere(1, { voll: true });
  const eintraegeVor = JSON.stringify((await D.eintraege(1)).map(e => [e.id, e.titel, e.datum, e.beginn, e.ende, e.ausnahmen]));
  const posVor = JSON.stringify(await D.positionen(1));
  const schreibVor = g.schreibaufrufe().length;
  for (let i = 0; i < 3; i++) await google.synchronisiere(1);
  assert.equal(g.schreibaufrufe().length, schreibVor, 'keine weiteren Schreibaufrufe');
  assert.equal(JSON.stringify((await D.eintraege(1)).map(e => [e.id, e.titel, e.datum, e.beginn, e.ende, e.ausnahmen])), eintraegeVor, 'keine lokalen Änderungen durch das Echo');
  assert.equal(JSON.stringify(await D.positionen(1)), posVor);
  // gleicher ETag wird ohne Verarbeitung übersprungen
  const ctx = { geaendert: 0, loeschen: [] };
  const ev = g.aktive()[0];
  const map = await KD.mapNachGoogleId(1, ev.id);
  assert.equal(map.etag, ev.etag);
});

// ── Kanal ──
test('Kanal: wird vor Ablauf erneuert, der alte gestoppt; weit entfernter Ablauf bleibt', async () => {
  await verbunden();
  assert.equal(g.kanaele.length, 1, 'beim Verbinden angelegt');
  const erster = (await KD.googleZeile(1)).channel_id;
  const k2 = await google.kanalSicherstellen(1);
  assert.equal(k2.erneuert, false, 'läuft noch lange');
  assert.equal(g.kanaele.length, 1);
  // Ablauf in 3 Stunden: Job erneuert
  await KD.googleSetzen(1, { channel_ablauf: new Date(Date.now() + 3 * 3600 * 1000) });
  const { runKalendersyncJob } = require('../jobs/kalendersync');
  const r = await runKalendersyncJob();
  assert.equal(r.kanaele, 1);
  assert.equal(g.kanaele.length, 2);
  const row = await KD.googleZeile(1);
  assert.notEqual(row.channel_id, erster);
  assert.deepEqual(g.gestoppt.map(s => s.id), [erster]);
  assert.ok(new Date(row.channel_ablauf).getTime() > Date.now() + 6 * 24 * 3600 * 1000);
  assert.equal(g.kanaele[1].params.ttl, '604800', 'höchstens 7 Tage');
  assert.notEqual(g.kanaele[0].token, g.kanaele[1].token, 'eigenes Geheimnis pro Kanal');
  // der alte Kanal wird nicht mehr akzeptiert
  assert.equal((await webhook(erster, g.kanaele[0].token)).status, 404);
  assert.equal((await webhook(row.channel_id, g.kanaele[1].token)).status, 200);
  await google._ruhe();
});

test('Job alle 15 Minuten gleicht als Sicherheitsnetz ab, auch ohne Webhook', async () => {
  await verbunden();
  g.handyNeu({ summary: 'Ohne Webhook', start: { dateTime: `${tag(2)}T08:00:00+02:00` }, end: { dateTime: `${tag(2)}T09:00:00+02:00` } });
  const { runKalendersyncJob } = require('../jobs/kalendersync');
  const r = await runKalendersyncJob();
  assert.equal(r.google, 1);
  assert.ok((await D.eintraege(1)).some(e => e.titel === 'Ohne Webhook'));
  process.env.KALENDERSYNC = 'aus';
  try { assert.equal((await runKalendersyncJob()).status, 'aus'); } finally { delete process.env.KALENDERSYNC; }
});

test('Abgleich beim Öffnen der Kalenderseite: «leise» überspringt einen frischen Abgleich', async () => {
  await verbunden();
  await call('POST', '/api/kalender/google/sync', {});
  const n = g.log.length;
  const r = await call('POST', '/api/kalender/google/sync', { leise: true });
  assert.equal(r.body.uebersprungen, true);
  assert.equal(g.log.length, n);
  const r2 = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(r2.body.ok, true);
  assert.equal((await call('POST', '/api/kalender/google/sync', {}, H.clientToken(klient.id))).status, 403);
});

test('Nicht verbunden: Abgleich meldet es klar, push ohne Verbindung tut nichts', async () => {
  const r = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(r.status, 409);
  await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  assert.equal(g.log.length, 0, 'keine Anfrage an Google ohne Verbindung');
});

// ── Trennen ──
test('Trennen widerruft das Token bei Google und löscht es lokal samt Verknüpfungen', async () => {
  await verbunden();
  await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  await kanalHolen();
  assert.equal((await H.pool.query('SELECT * FROM kalender_google_map')).rows.length, 1);
  const r = await call('POST', '/api/kalender/google/trennen', {});
  assert.equal(r.body.ok, true);
  assert.equal(r.body.widerrufen, true);
  assert.deepEqual(g.widerrufen, [g.refresh]);
  assert.equal(g.gestoppt.length, 1, 'Kanal gestoppt');
  assert.equal(await KD.googleZeile(1), null);
  assert.equal((await H.pool.query('SELECT * FROM kalender_google_map')).rows.length, 0);
  assert.equal((await call('GET', '/api/kalender/google/status')).body.verbunden, false);
  assert.ok(!JSON.stringify(r.body).includes(g.refresh));
  // danach schreibt nichts mehr nach Google
  const n = g.log.length;
  await call('POST', '/api/tagesplan/termine', termin({ titel: 'Nach Trennen' }));
  await google._ruhe();
  assert.equal(g.log.length, n);
});

test('Abgelaufene Verbindung (invalid_grant) wird als Fehler gemeldet, ohne Wiederholungsschleife', async () => {
  await verbunden();
  g.refresh = 'ein-anderes-token';
  GA.tokenVergessen(1);
  await call('POST', '/api/tagesplan/termine', termin());
  const r = await call('POST', '/api/kalender/google/sync', {});
  assert.equal(r.body.ok, false);
  assert.match(r.body.fehler, /abgelaufen/);
  assert.equal(r.body.code, 'invalid_grant');
});

test('Termine werden nicht mehrfach angelegt, wenn Google die ID schon kennt (409)', async () => {
  await verbunden();
  const c = await call('POST', '/api/tagesplan/termine', termin());
  await google._ruhe();
  await H.pool.query('DELETE FROM kalender_google_map'); // Verknüpfung verloren
  await google.synchronisiere(1);
  assert.equal(g.aktive().length, 1);
  assert.ok(c.body.id);
});
