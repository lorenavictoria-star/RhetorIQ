// Kostenloser Stimm-Schnelltest: Ablauf und Missbrauchsschutz (pg-mem, KI- und Mail-Attrappe).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

const PAGE = '<html><head><title>Muster AG</title></head><body>' + '<p>Wir sind ein führender Anbieter ganzheitlicher Lösungen im Sinne nachhaltiger Wertschöpfung für unsere Kundschaft.</p>'.repeat(6) + '</body></html>';
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
  assert.match(r.body.ergebnis.naechsterSchritt, /CHF 950/);
  assert.equal(H.ai.calls.length, 1);
  assert.equal(H.ai.calls[0].meter.module, 'schnelltest');
  const { rows } = await pool.query('SELECT * FROM schnelltests WHERE host=$1', ['muster.ch']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'gast@test.ch');
  assert.ok(rows[0].ergebnis.length <= 1200);
  await new Promise(r2 => setTimeout(r2, 20));
  const m = H.mails.find(x => x.kind === 'schnelltest_notify');
  assert.ok(m && m.text.includes('gast@test.ch') && m.text.includes('muster.ch') && m.text.includes('Floskeln'));
});

test('gleiche Adresse oder E-Mail nur einmal pro 24 Stunden', async () => {
  assert.equal((await post(big, { url: 'https://www.muster.ch/andere', email: 'neu1@test.ch' })).status, 429, 'gleiche Webseite');
  assert.equal((await post(big, { url: 'ganzneu.ch', email: 'gast@test.ch' })).status, 429, 'gleiche E-Mail');
  assert.equal((await post(big, { url: 'ganzneu.ch', email: 'neu2@test.ch' })).status, 200);
});

test('Herkunft, Honeypot und Zeitfalle', async () => {
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
  assert.match(r.body.error, /heute/);
  await pool.query(`DELETE FROM schnelltests`);
});

test('Ratenbegrenzung pro IP', async () => {
  H.ai.reply = REPLY;
  assert.equal((await post(small, { url: 'r1.ch', email: 'r1@test.ch' })).status, 200);
  assert.equal((await post(small, { url: 'r2.ch', email: 'r2@test.ch' })).status, 200);
  assert.equal((await post(small, { url: 'r3.ch', email: 'r3@test.ch' })).status, 429);
});
