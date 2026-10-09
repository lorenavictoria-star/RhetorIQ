// Kommunikationsprofil: Ausgangslage, Ziel, Messung und Zugriff.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, a, b;
const SCORES = { klarheit: 60, waerme: 40, direktheit: 55, verstaendlichkeit: 45, kuerze: 30, verbindlichkeit: 70 };
const REPLY = JSON.stringify({ scores: SCORES, findings: [{ title: 'Lange Sätze', detail: 'Im Schnitt über 30 Wörter.' }] });
const LONG = 'Wir freuen uns im Sinne von nachhaltigem Wachstum Ihnen mitzuteilen, dass wir die Allokation der Ressourcen zeitnah anpassen werden. '.repeat(6);

test.before(async () => {
  await H.setupBase();
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  await pool.query(`CREATE TABLE IF NOT EXISTS company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  srv = await H.startApp([['/api/comm-profile', require('../routes/commProfile')]]);
  H.ai.reply = REPLY;
});
test.after(async () => { await srv.close(); });

test('Metriken zählen Satzlänge und Wendungen ohne KI', () => {
  const m = require('../lib/commProfile').computeMetrics([LONG, LONG]);
  assert.ok(m.avgSentenceLength > 15);
  assert.ok(m.topPhrases.length > 0);
});

test('Ausgangslage anlegen, nur Beraterin, Werte begrenzt', async () => {
  assert.equal((await srv.call('POST', `/api/comm-profile/${a.id}/baseline`, { token: H.clientToken(a.id), body: { texts: LONG } })).status, 403);
  const r = await srv.call('POST', `/api/comm-profile/${a.id}/baseline`, { token: H.advisorToken(), body: { texts: LONG } });
  assert.equal(r.status, 200);
  assert.equal(r.body.baseline.scores.waerme, 40);
  assert.equal(r.body.baseline.findings[0].title, 'Lange Sätze');
  assert.equal(r.body.dims.length, 6);
});

test('zu kurzer Text wird abgelehnt', async () => {
  const r = await srv.call('POST', `/api/comm-profile/${a.id}/baseline`, { token: H.advisorToken(), body: { texts: 'Kurz.' } });
  assert.equal(r.status, 400);
});

test('Ziel setzen und von Klient lesen, fremder Klient gesperrt', async () => {
  const t = await srv.call('PUT', `/api/comm-profile/${a.id}/target`, { token: H.advisorToken(), body: { scores: { ...SCORES, waerme: 80, kuerze: 150 } } });
  assert.equal(t.body.target.scores.waerme, 80);
  assert.equal(t.body.target.scores.kuerze, 100, 'auf 100 begrenzt');
  assert.equal((await srv.call('GET', `/api/comm-profile/${a.id}`, { token: H.clientToken(a.id) })).status, 200);
  assert.equal((await srv.call('GET', `/api/comm-profile/${a.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('PUT', `/api/comm-profile/${a.id}/target`, { token: H.clientToken(a.id), body: { scores: SCORES } })).status, 403);
});

test('Messung braucht neue verwendete Texte', async () => {
  const none = await srv.call('POST', `/api/comm-profile/${a.id}/snapshot`, { token: H.advisorToken() });
  assert.equal(none.status, 400);
  for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, result) VALUES ($1,1,'text-gen',$2)`, [a.id, LONG]);
  const ok = await srv.call('POST', `/api/comm-profile/${a.id}/snapshot`, { token: H.advisorToken() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.snapshots.length, 1);
  assert.equal(ok.body.latest.text_count, 3);
});

test('Stimmprofil als Word: nur Beraterin, enthält Firma und Übereinstimmung', async () => {
  const c = await H.addClient('Wort AG');
  assert.equal((await srv.call('GET', `/api/comm-profile/${c.id}/report.docx`, { token: H.advisorToken() })).status, 400, 'ohne Ausgangslage');
  await srv.call('POST', `/api/comm-profile/${c.id}/baseline`, { token: H.advisorToken(), body: { texts: LONG } });
  await srv.call('PUT', `/api/comm-profile/${c.id}/target`, { token: H.advisorToken(), body: { scores: { klarheit: 80, waerme: 70, direktheit: 70, verstaendlichkeit: 80, kuerze: 70, verbindlichkeit: 75 } } });
  const { buildReport } = require('../lib/stimmReport');
  const r = await buildReport(c.id);
  assert.ok(r.buffer.length > 5000);
  const JSZip = require('jszip');
  const z = await JSZip.loadAsync(r.buffer);
  const xml = await z.file('word/document.xml').async('string');
  assert.ok(xml.includes('Wort AG'));
  assert.ok(xml.includes('Klingt wie ich'));
  assert.ok(xml.includes('Lange Sätze'), 'Befund aus der Auswertung');
  assert.equal(typeof r.match, 'number');
  assert.equal((await srv.call('GET', `/api/comm-profile/${c.id}/report.docx`, { token: H.clientToken(c.id) })).status, 403);
});

