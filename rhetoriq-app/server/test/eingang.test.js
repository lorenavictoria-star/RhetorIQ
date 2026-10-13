// Eingang der Beraterin: Zähler, Sortierung, Rollenschutz, Mandantentrennung und Mail-Empfang (Token, Duplikate, Adresse, HTML, Länge).
process.env.ABO_PFLICHT_AB = '2099-01-01T00:00:00Z';
process.env.EINGANG_MAIL_ADRESSE = 'contact@lorenalienhard.ch';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;
const E = require('../lib/eingang');
const route = require('../routes/eingang');

let srv, srvKlein, tAdv;
const SECRET = 'geheim-fuer-tests';
const MAIL = '/api/eingang/mail';

test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE inquiries (id SERIAL PRIMARY KEY, name TEXT NOT NULL, company TEXT, email TEXT NOT NULL, message TEXT, source TEXT DEFAULT 'webseite',
    status TEXT NOT NULL DEFAULT 'neu', anrede TEXT, workshop_date TEXT, ack_sent_at TIMESTAMPTZ, vorab_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER');
  await pool.query('ALTER TABLE clients ADD COLUMN recommended_plan TEXT');
  await E.ensureSchema();
  await require('../lib/buchungDaten').ensureSchema();
  await require('../lib/warteliste').ensureSchema();
  const r = route.build();
  srv = await H.startApp([['/api/assistent/eingang', r.advisorRouter], ['/api/eingang', r.mailRouter]]);
  const k = route.build({ mailMax: 3 });
  srvKlein = await H.startApp([['/api/eingang', k.mailRouter]]);
  tAdv = H.advisorToken();
});
test.after(async () => { await srv.close(); await srvKlein.close(); });

async function leeren() {
  for (const t of ['review_requests', 'inquiries', 'inbox_mails', 'buchungen', 'warteliste', 'clients']) await pool.query(`DELETE FROM ${t}`);
  process.env.EINGANG_MAIL_SECRET = SECRET;
}
test.beforeEach(leeren);

const vor = (min) => new Date(Date.now() - min * 60000);
async function fuellen() {
  const c = await H.addClient('Muster AG');
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, created_at) VALUES ($1,'Newsletter','x',$2)`, [c.id, vor(30)]);
  await pool.query(`INSERT INTO inquiries (name, company, email, message, created_at) VALUES ('Berta','Firma GmbH','b@f.ch','Ich habe eine Frage',$1)`, [vor(10)]);
  await pool.query(`INSERT INTO inquiries (name, email, status, created_at) VALUES ('Alt','a@f.ch','archiviert',$1)`, [vor(5)]);
  await pool.query(`INSERT INTO inbox_mails (von_name, von_adresse, an_adresse, betreff, auszug, empfangen_am, message_id) VALUES ('Carl','c@f.ch','contact@lorenalienhard.ch','Hallo','Kurztext',$1,'m1')`, [vor(5)]);
  const morgen = new Date(Date.now() + 86400000);
  await pool.query(`INSERT INTO buchungen (advisor_id, name, email, start_at, ende_at, datum, beginn, ende, status, slot_key, created_at) VALUES (1,'Dora','d@f.ch',$1,$2,'2099-01-01',600,660,'gebucht','k1',$3)`, [morgen, morgen, vor(20)]);
  await pool.query(`INSERT INTO warteliste (name, email, unternehmen, anliegen, created_at) VALUES ('Emil','e@f.ch','E AG','Platz bitte',$1)`, [vor(1)]);
  return c;
}

test('Zähler und Sortierung: neueste zuerst, alle Quellen', async () => {
  await fuellen();
  const r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.zaehler, { alle: 5, freigaben: 1, anfragen: 1, mails: 1, termine: 1, warteliste: 1 });
  assert.deepEqual(r.body.eintraege.map(e => e.typ), ['warteliste', 'mail', 'anfrage', 'termin', 'freigabe']);
  const zeiten = r.body.eintraege.map(e => e.zeit);
  assert.deepEqual([...zeiten].sort().reverse(), zeiten);
  const mail = r.body.eintraege.find(e => e.typ === 'mail');
  assert.equal(mail.neu, true);
  assert.equal(mail.titel, 'Hallo');
  assert.ok(r.body.eintraege.every(e => e.id && e.titel && e.info !== undefined && e.ziel));
});

test('Leerer Eingang und Höchstzahl 50', async () => {
  let r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.deepEqual(r.body, { zaehler: { alle: 0, freigaben: 0, anfragen: 0, mails: 0, termine: 0, warteliste: 0 }, eintraege: [] });
  for (let i = 0; i < 60; i++) await pool.query(`INSERT INTO inquiries (name, email, created_at) VALUES ($1,'x@y.ch',$2)`, ['A' + i, vor(i)]);
  r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.equal(r.body.eintraege.length, 50);
  assert.equal(r.body.zaehler.alle, 60);
});

test('Rollenschutz: Kunde 403, ohne Anmeldung 401', async () => {
  const c = await fuellen();
  assert.equal((await srv.call('GET', '/api/assistent/eingang', { token: H.clientToken(c.id) })).status, 403);
  assert.equal((await srv.call('GET', '/api/assistent/eingang')).status, 401);
  assert.equal((await srv.call('POST', '/api/assistent/eingang/mail/1/gelesen', { token: H.clientToken(c.id) })).status, 403);
});

test('Mandantentrennung: Freigaben fremder oder gelöschter Kunden fehlen', async () => {
  const c = await fuellen();
  const fremd = (await pool.query(`INSERT INTO clients (advisor_id, name, slug, token) VALUES (2,'Fremd AG','fremd1','tfremd1') RETURNING id`)).rows[0];
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'Geheim','x')`, [fremd.id]);
  const weg = (await pool.query(`INSERT INTO clients (advisor_id, name, slug, token, geloescht_am) VALUES (1,'Weg AG','weg1','tweg1', NOW()) RETURNING id`)).rows[0];
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'Weg','x')`, [weg.id]);
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, status) VALUES ($1,'Erledigt','x','approved')`, [c.id]);
  const r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.equal(r.body.zaehler.freigaben, 1);
  assert.ok(!JSON.stringify(r.body).includes('Fremd AG') && !JSON.stringify(r.body).includes('Geheim') && !JSON.stringify(r.body).includes('Weg'));
  const b = await pool.query(`INSERT INTO buchungen (advisor_id, name, email, start_at, ende_at, datum, beginn, ende, status, slot_key) VALUES (2,'Fremdtermin','z@f.ch',NOW(),NOW(),'2099-01-01',600,660,'gebucht','k9') RETURNING id`);
  assert.ok(b.rows[0]);
  const r2 = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.ok(!JSON.stringify(r2.body).includes('Fremdtermin'));
});

test('Mail als gelesen markieren', async () => {
  await fuellen();
  const id = (await pool.query(`SELECT id FROM inbox_mails`)).rows[0].id;
  assert.equal((await srv.call('POST', `/api/assistent/eingang/mail/${id}/gelesen`, { token: tAdv })).status, 200);
  const r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.equal(r.body.eintraege.find(e => e.typ === 'mail').neu, false);
  assert.equal((await srv.call('POST', '/api/assistent/eingang/mail/99999/gelesen', { token: tAdv })).status, 404);
  assert.equal((await srv.call('POST', '/api/assistent/eingang/mail/abc/gelesen', { token: tAdv })).status, 400);
});

async function mailPost(body, token = SECRET, s = srv) {
  const headers = { 'Content-Type': 'application/json' };
  if (token != null) headers['x-eingang-token'] = token;
  const r = await fetch(s.base + MAIL, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const mail = (extra = {}) => ({ von: 'Anna Muster <anna@firma.ch>', an: 'contact@lorenalienhard.ch', betreff: 'Frage', text: 'Guten Tag, ich habe eine Frage.', message_id: '<a1@firma.ch>', ...extra });
const anzahl = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM inbox_mails')).rows[0].n;

test('Mail-Empfang: Token fehlt, falsch, Variable ungesetzt', async () => {
  assert.equal((await mailPost(mail(), null)).status, 401);
  assert.equal((await mailPost(mail(), 'falsch')).status, 401);
  assert.equal(await anzahl(), 0);
  delete process.env.EINGANG_MAIL_SECRET;
  assert.equal((await mailPost(mail(), SECRET)).status, 503);
  assert.equal((await mailPost(mail(), '')).status, 503);
});

test('Mail-Empfang: speichert, Doppelte ignoriert, erscheint im Eingang', async () => {
  const a = await mailPost(mail());
  assert.equal(a.status, 200); assert.equal(a.body.gespeichert, true);
  const b = await mailPost(mail());
  assert.equal(b.status, 200); assert.equal(b.body.gespeichert, false);
  assert.equal(await anzahl(), 1);
  const r = await srv.call('GET', '/api/assistent/eingang', { token: tAdv });
  assert.equal(r.body.zaehler.mails, 1);
  assert.equal(r.body.eintraege[0].titel, 'Frage');
  assert.ok(r.body.eintraege[0].info.includes('anna@firma.ch'));
});

test('Mail-Empfang: falsche Empfängeradresse wird nicht gespeichert, Liste mit Zieladresse schon', async () => {
  const a = await mailPost(mail({ an: 'jemand@anders.ch', message_id: 'x1' }));
  assert.equal(a.status, 200); assert.equal(a.body.gespeichert, false);
  assert.equal(await anzahl(), 0);
  const b = await mailPost(mail({ an: ['x@y.ch', 'Lorena <Contact@LorenaLienhard.ch>'], message_id: 'x2' }));
  assert.equal(b.body.gespeichert, true);
});

test('Mail-Empfang: HTML wird entfernt, Auszug höchstens 300 Zeichen', async () => {
  const a = await mailPost(mail({ text: undefined, html: '<style>p{color:red}</style><p>Hallo <b>Welt</b></p><script>alert(1)</script><img src=x onerror=alert(1)>&amp; Ende', message_id: 'h1' }));
  assert.equal(a.body.gespeichert, true);
  let row = (await pool.query(`SELECT auszug FROM inbox_mails WHERE message_id='h1'`)).rows[0];
  assert.equal(row.auszug, 'Hallo Welt & Ende');
  await mailPost(mail({ text: 'x '.repeat(5000), message_id: 'l1' }));
  row = (await pool.query(`SELECT auszug FROM inbox_mails WHERE message_id='l1'`)).rows[0];
  assert.ok(row.auszug.length <= 300);
  await mailPost(mail({ text: '<b>fett</b> <a href="http://x">Link</a>', message_id: 'h2' }));
  row = (await pool.query(`SELECT auszug FROM inbox_mails WHERE message_id='h2'`)).rows[0];
  assert.equal(row.auszug, 'fett Link');
});

test('Mail-Empfang: Grössenlimit und fehlende Felder', async () => {
  const gross = await mailPost(mail({ text: 'a'.repeat(400 * 1024), message_id: 'g1' }));
  assert.equal(gross.status, 413);
  assert.equal(await anzahl(), 0);
  assert.equal((await mailPost({ betreff: 'ohne Absender' })).status, 400);
});

test('Mail-Empfang: Ratenbegrenzung', async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await mailPost(mail({ message_id: 'r' + i }), SECRET, srvKlein)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});
