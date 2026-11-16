// Kostenloser Test «Wie klingt Ihre Firma?»: Ablauf und Missbrauchsschutz (pg-mem, KI- und Mail-Attrappe).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

const PAGE = '<html><head><title>Muster AG</title></head><body>' + [1, 2, 3, 4, 5, 6].map(i => `<p>Wir sind ein führender Anbieter ganzheitlicher Lösungen Nummer ${i} im Sinne nachhaltiger Wertschöpfung für unsere Kundschaft.</p>`).join('') + '</body></html>';
const REPLY = JSON.stringify({ befunde: ['Die Sätze sind lang.', 'Viele Floskeln wie «führender Anbieter».', 'Die Lesenden werden kaum direkt angesprochen.'] });
let fetched = [];
const fetchHtml = async (u) => { fetched.push(u); if (/kaputt/.test(u)) throw new Error('weg'); if (/leer/.test(u)) return { html: '<p>Hi</p>' }; return { html: PAGE }; };

let srv, big, small;
async function post(s, body, { origin = 'https://rhetoriq.ch' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const r = await fetch(s.base + '/api/schnelltest', { method: 'POST', headers, body: JSON.stringify({ elapsed: 5000, ...body }) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

test.before(async () => {
  await H.setupBase();
  const { makeRouter } = require('../routes/schnelltest');
  big = await H.startApp([['/api/schnelltest', makeRouter({ max: 1000, fetchHtml })]]);
  small = await H.startApp([['/api/schnelltest', makeRouter({ max: 2, fetchHtml })]]);
  H.ai.reply = REPLY;
});
test.after(async () => { await big.close(); await small.close(); });

test('Schnelltest liefert drei Befunde, speichert und meldet an Lorena', async () => {
  H.ai.calls.length = 0; H.mails.length = 0;
  const r = await post(big, { url: 'muster.ch', email: 'Gast@Test.ch' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ergebnis.befunde.length, 3);
  assert.match(r.body.ergebnis.naechsterSchritt, /«Die Stimme finden» werten wir zehn Ihrer Texte/);
  assert.equal(H.ai.calls[0].meter.module, 'schnelltest');
  const { rows } = await pool.query('SELECT * FROM schnelltests WHERE host=$1', ['muster.ch']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'gast@test.ch');
  assert.ok(rows[0].ergebnis.length <= 1200);
  // Die tiefe Analyse läuft danach im Hintergrund, die Hinweis-Mail kommt erst mit ihrem Ergebnis
  await require('../routes/schnelltest').drain();
  assert.equal(H.ai.calls.length, 2);
  assert.equal(H.ai.calls[1].meter.module, 'schnelltest_tief');
  const m = H.mails.find(x => x.kind === 'schnelltest_notify');
  const eg = H.mails.find(x => x.kind === 'schnelltest_ergebnis');
  assert.ok(eg && eg.to === 'gast@test.ch' && eg.text.includes('1. Die Sätze sind lang.') && eg.text.includes('/termin') && !/CHF/.test(eg.text), 'Ergebnis-Mail an die Person');
  assert.ok(m && m.text.includes('gast@test.ch') && m.text.includes('muster.ch') && m.text.includes('Kennzahlen'));
});

test('dieselbe Webseite oder E-Mail höchstens dreimal pro 24 Stunden', async () => {
  // muster.ch hat schon einen Test (erster Test oben): zwei weitere gehen, der vierte nicht
  assert.equal((await post(big, { url: 'https://www.muster.ch/andere', email: 'neu1@test.ch' })).status, 200, 'zweiter Test derselben Webseite');
  assert.equal((await post(big, { url: 'muster.ch', email: 'neu1b@test.ch' })).status, 200, 'dritter Test derselben Webseite');
  assert.equal((await post(big, { url: 'muster.ch', email: 'neu1c@test.ch' })).status, 429, 'vierter Test derselben Webseite');
  // gast@test.ch hat einen Test: zwei weitere mit anderen Webseiten gehen, der vierte nicht
  assert.equal((await post(big, { url: 'ganzneu.ch', email: 'gast@test.ch' })).status, 200);
  assert.equal((await post(big, { url: 'ganzneu2.ch', email: 'gast@test.ch' })).status, 200);
  const r = await post(big, { url: 'ganzneu3.ch', email: 'gast@test.ch' });
  assert.equal(r.status, 429, 'vierter Test derselben E-Mail');
  assert.match(r.body.error, /drei Tests/);
  await require('../routes/schnelltest').drain();
});

test('nach der tiefen Analyse stehen die stärksten Auffälligkeiten (bis drei) schon vorgewählt', async () => {
  H.mails.length = 0;
  assert.equal((await post(big, { url: 'vorwahl.ch', email: 'vw@test.ch' })).status, 200);
  await require('../routes/schnelltest').drain();
  const { rows } = await pool.query(`SELECT auswahl, kandidaten, status FROM schnelltests WHERE host='vorwahl.ch'`);
  const auswahl = typeof rows[0].auswahl === 'string' ? JSON.parse(rows[0].auswahl) : rows[0].auswahl;
  const kand = typeof rows[0].kandidaten === 'string' ? JSON.parse(rows[0].kandidaten) : rows[0].kandidaten;
  assert.equal(auswahl.length, Math.min(3, kand.length));
  assert.ok(auswahl.length >= 1);
  assert.equal(new Set(auswahl).size, auswahl.length);
  assert.ok(auswahl.every(id => kand.some(c => c.id === id)));
  assert.equal(rows[0].status || 'entwurf', 'entwurf', 'Lorena gibt selbst frei');
  const m = H.mails.find(x => x.kind === 'schnelltest_notify');
  assert.ok(m && m.text.includes('schon für Dich vorgewählt'));
});

test('Herkunft, Honeypot und Zeitfalle', async () => {
  await require('../routes/schnelltest').drain();
  H.ai.calls.length = 0;
  assert.equal((await post(big, { url: 'a1.ch', email: 'a1@test.ch' }, { origin: 'https://boese.example' })).status, 401);
  assert.equal((await post(big, { url: 'a1.ch', email: 'a1@test.ch' }, { origin: null })).status, 401);
  const hp = await post(big, { url: 'a1.ch', email: 'a1@test.ch', website2: 'bot' });
  assert.equal(hp.status, 200); assert.equal(hp.body.ergebnis, null);
  const fast = await post(big, { url: 'a1.ch', email: 'a1@test.ch', elapsed: 300 });
  assert.equal(fast.body.ergebnis, null);
  assert.equal(H.ai.calls.length, 0, 'kein KI-Aufruf für Bots');
});

test('nur öffentliche Webadressen, ungültige E-Mail', async () => {
  const real = await require('../routes/schnelltest').makeRouter; // vorhanden
  assert.ok(real);
  for (const u of ['http://localhost/x', 'http://127.0.0.1', 'ftp://x.ch', 'http://10.0.0.5', 'http://169.254.169.254/latest']) {
    assert.equal((await post(big, { url: u, email: 'x' + Math.random().toString(36).slice(2, 6) + '@test.ch' })).status, 400, u);
  }
  assert.equal((await post(big, { url: 'b1.ch', email: 'keine-mail' })).status, 400);
});

test('Webseite nicht ladbar oder leer gibt Fehler und gibt den Platz wieder frei', async () => {
  assert.equal((await post(big, { url: 'kaputt.ch', email: 'k1@test.ch' })).status, 422);
  assert.equal((await post(big, { url: 'leer.ch', email: 'k2@test.ch' })).status, 422);
  const { rows } = await pool.query(`SELECT 1 FROM schnelltests WHERE host IN ('kaputt.ch','leer.ch')`);
  assert.equal(rows.length, 0);
});

test('gescheiterter Test meldet Webseite, E-Mail und Grund an Lorena', async () => {
  H.mails.length = 0;
  assert.equal((await post(big, { url: 'kaputt.ch', email: 'Wartet@Test.ch' })).status, 422);
  await new Promise(r => setTimeout(r, 50));
  const m = H.mails.find(x => x.kind === 'schnelltest_fehler');
  assert.ok(m, 'Fehler-Mail an Lorena');
  assert.ok(m.text.includes('kaputt.ch') && m.text.includes('Wartet@Test.ch') && m.text.includes('Die Webseite konnte nicht geladen werden'), 'Webseite, E-Mail und Grund stehen drin');
  assert.match(m.subject, /nicht durchgelaufen/);
});

test('technischer Fehler: Person sieht nie «nicht verfügbar», Lorena bekommt die Angaben', async () => {
  H.mails.length = 0; H.ai.fail = true;
  try {
    const r = await post(big, { url: 'fehler.ch', email: 'Wartet2@Test.ch' });
    assert.equal(r.status, 202);
    assert.match(r.body.nachricht, /Ihre Angaben sind bei mir angekommen/);
    assert.ok(!JSON.stringify(r.body).includes('nicht verfügbar'));
    await new Promise(x => setTimeout(x, 50));
    const m = H.mails.find(x => x.kind === 'schnelltest_fehler');
    assert.ok(m && m.text.includes('fehler.ch') && m.text.includes('Wartet2@Test.ch') && m.text.includes('KI kaputt'));
    assert.equal((await pool.query(`SELECT 1 FROM schnelltests WHERE host='fehler.ch'`)).rows.length, 0);
  } finally { H.ai.fail = false; }
});

test('unlesbare KI-Antwort gibt 422 ohne Eintrag', async () => {
  H.ai.reply = 'Keine JSON-Antwort';
  assert.equal((await post(big, { url: 'parse.ch', email: 'p1@test.ch' })).status, 422);
  H.ai.reply = REPLY;
  assert.equal((await pool.query(`SELECT 1 FROM schnelltests WHERE host='parse.ch'`)).rows.length, 0);
});

test('höchstens 150 Tests pro Tag insgesamt', async () => {
  await pool.query(`DELETE FROM schnelltests`);
  for (let i = 0; i < 150; i++) await pool.query(`INSERT INTO schnelltests (url, host, email) VALUES ($1,$2,$3)`, ['https://x' + i + '.ch', 'x' + i + '.ch', 'x' + i + '@t.ch']);
  const r = await post(big, { url: 'tag.ch', email: 'tag@test.ch' });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Heute sind alle kostenlosen Tests vergeben/);
  assert.match(r.body.error, /contact@lorenalienhard\.ch/);
  await pool.query(`DELETE FROM schnelltests`);
});

test('Ratenbegrenzung pro IP', async () => {
  H.ai.reply = REPLY;
  assert.equal((await post(small, { url: 'r1.ch', email: 'r1@test.ch' })).status, 200);
  assert.equal((await post(small, { url: 'r2.ch', email: 'r2@test.ch' })).status, 200);
  assert.equal((await post(small, { url: 'r3.ch', email: 'r3@test.ch' })).status, 429);
});
