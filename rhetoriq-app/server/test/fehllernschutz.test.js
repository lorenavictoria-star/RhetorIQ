// Fehllernschutz: Nachfragen und Fakten werden nur vorgeschlagen, gelernte Sätze haben Datum, Zähler und lassen sich vergessen.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');

let srv;
const A = () => H.advisorToken();
test.before(async () => {
  await H.setupBase();
  await H.pool.query(`CREATE TABLE client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
  await H.pool.query(`CREATE TABLE client_feedback_history (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT, category TEXT, rating INTEGER, note TEXT)`);
  await require('../lib/schemaRedesign').ensureSchema();
  srv = await H.startApp([
    ['/api/analyze', require('../routes/analyze')],
    ['/api/learning', require('../routes/learning')]
  ]);
});
test.after(async () => { await srv.close(); });

async function analysis(clientId, key = 'text-gen-email') {
  const { rows } = await H.pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result, feedback_key) VALUES ($1,1,'text-gen','Text',$2,$3) RETURNING id`, [clientId, 'Ergebnis', key]);
  return rows[0].id;
}
async function waitFor(fn) {
  for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); }
  return null;
}
const suggestions = (cid) => H.pool.query(`SELECT * FROM learning_suggestions WHERE client_id=$1 ORDER BY id`, [cid]).then(r => r.rows);
const learnings = (cid) => H.pool.query(`SELECT * FROM client_feedback_learnings WHERE client_id=$1`, [cid]).then(r => r.rows);

test('Nachfrage des Klienten wird Lernvorschlag und nicht sofort gelernt, Wiederholung erhöht die Gewichtung', async () => {
  const cl = await H.addClient('Nachfrage AG');
  const T = H.clientToken(cl.id);
  H.ai.fail = false;
  H.ai.reply = '{"category":"STRUKTUR","observation":"Absätze kürzer halten, höchstens vier Sätze."}';
  const id1 = await analysis(cl.id);
  const r1 = await srv.call('POST', `/api/analyze/${id1}/rate`, { token: T, body: { rating: -1, note: 'Absatz 2 kürzer', source: 'nachfrage' } });
  assert.equal(r1.status, 200);
  const s1 = await waitFor(async () => { const s = await suggestions(cl.id); return s.length ? s : null; });
  assert.equal(s1.length, 1);
  assert.equal(s1[0].status, 'offen');
  assert.equal(s1[0].source, 'nachfrage');
  assert.equal(s1[0].weight, 'normal');
  assert.equal((await learnings(cl.id)).length, 0, 'noch nichts gelernt');
  // derselbe Wunsch nochmals (innert 60 Tagen): gleicher Vorschlag, höhere Gewichtung
  const id2 = await analysis(cl.id);
  await srv.call('POST', `/api/analyze/${id2}/rate`, { token: T, body: { rating: -1, note: 'Absätze bitte kürzer', source: 'nachfrage' } });
  const s2 = await waitFor(async () => { const s = await suggestions(cl.id); return s[0].occurrences >= 2 ? s : null; });
  assert.equal(s2.length, 1);
  assert.equal(s2[0].weight, 'hoch');
  assert.equal((await learnings(cl.id)).length, 0, 'auch bei Wiederholung nur Vorschlag');
  const list = await srv.call('GET', `/api/learning?client_id=${cl.id}`, { token: A() });
  assert.equal(list.body[0].weight, 'hoch');
  // älter als 60 Tage: Zähler beginnt neu
  await H.pool.query(`UPDATE learning_suggestions SET updated_at = NOW() - INTERVAL '90 days' WHERE client_id=$1`, [cl.id]);
  const id3 = await analysis(cl.id);
  await srv.call('POST', `/api/analyze/${id3}/rate`, { token: T, body: { rating: -1, note: 'Absätze kürzer bitte', source: 'nachfrage' } });
  const s3 = await waitFor(async () => { const s = await suggestions(cl.id); return new Date(s[0].updated_at) > new Date(Date.now() - 3600e3) ? s : null; });
  assert.equal(s3[0].occurrences, 1);
  assert.equal(s3[0].weight, 'normal');
});

test('Nachfrage zu Fakten bleibt Vorschlag; Daumen-Notiz ohne Nachfrage lernt weiter direkt, ausser bei Fakten', async () => {
  const cl = await H.addClient('Fakten AG');
  const T = H.clientToken(cl.id);
  H.ai.reply = '{"category":"FAKTEN","observation":"Die Gründung war 1987."}';
  const a1 = await analysis(cl.id);
  await srv.call('POST', `/api/analyze/${a1}/rate`, { token: T, body: { rating: -1, note: 'Gründung war 1987', source: 'nachfrage' } });
  const s = await waitFor(async () => { const x = await suggestions(cl.id); return x.length ? x : null; });
  assert.equal(s[0].category, 'FAKTEN');
  assert.equal((await learnings(cl.id)).length, 0);
  // Daumen runter mit Notiz (Stil): wie bisher direkt gelernt
  H.ai.reply = 'KATEGORIE: TON\nZUSAMMENFASSUNG: Warm und direkt schreiben.';
  const a2 = await analysis(cl.id);
  await srv.call('POST', `/api/analyze/${a2}/rate`, { token: T, body: { rating: -1, note: 'zu kühl' } });
  const l = await waitFor(async () => { const x = await learnings(cl.id); return x.length ? x : null; });
  assert.equal(l[0].summary, 'Warm und direkt schreiben.');
  // Daumen mit Notiz, KI ordnet als FAKTEN ein: nur Vorschlag
  H.ai.reply = 'KATEGORIE: FAKTEN\nZUSAMMENFASSUNG: Umsatz 2023 betrug 4 Millionen.';
  const a3 = await analysis(cl.id);
  await srv.call('POST', `/api/analyze/${a3}/rate`, { token: T, body: { rating: -1, note: 'Umsatz 2023 war 4 Millionen' } });
  const s3 = await waitFor(async () => { const x = await suggestions(cl.id); return x.length >= 2 ? x : null; });
  assert.ok(s3.some(x => x.observation.includes('4 Millionen')));
  assert.equal((await learnings(cl.id)).length, 1, 'Fakten wurden nicht automatisch gelernt');
});

test('Gelernte Sätze: Datum und Zähler, Altbestand unverändert, einzelner Satz vergessen', async () => {
  const cl = await H.addClient('Gelernt AG');
  const other = await H.addClient('Fremd AG');
  // Altbestand ohne Angaben je Satz
  await H.pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary, updated_at) VALUES ($1,'text-gen-email','TON','Warm schreiben. Kurze Sätze verwenden.', '2026-01-05T10:00:00Z')`, [cl.id]);
  const before = await srv.call('GET', `/api/learning/learned?client_id=${cl.id}`, { token: A() });
  assert.equal(before.status, 200);
  assert.equal(before.body[0].saetze.length, 2);
  assert.equal(before.body[0].saetze[0].count, 1);
  assert.ok(new Date(before.body[0].saetze[0].at).toISOString().startsWith('2026-01-05'));
  // Vorschlag übernehmen: neuer Satz mit Datum und Zähler, alter Text unverändert
  const { rows: sg } = await H.pool.query(`INSERT INTO learning_suggestions (client_id, module_key, category, observation, occurrences) VALUES ($1,'text-gen-email','TON','Immer mit Vornamen anreden.',3) RETURNING id`, [cl.id]);
  assert.equal((await srv.call('POST', `/api/learning/${sg[0].id}/accept`, { token: A() })).status, 200);
  const after = await srv.call('GET', `/api/learning/learned?client_id=${cl.id}`, { token: A() });
  const sat = after.body[0].saetze;
  assert.equal(sat.length, 3);
  assert.equal(sat[0].text, 'Warm schreiben.');
  assert.ok(new Date(sat[0].at).toISOString().startsWith('2026-01-05'));
  assert.equal(sat[2].text, 'Immer mit Vornamen anreden.');
  assert.equal(sat[2].count, 3);
  assert.ok(new Date(sat[2].at) > new Date(Date.now() - 3600e3));
  // Vergessen
  const id = after.body[0].id;
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: H.clientToken(cl.id), body: { text: 'Warm schreiben.' } })).status, 403);
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: A(), body: {} })).status, 400);
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: A(), body: { text: 'Gibt es nicht.' } })).status, 404);
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: A(), body: { text: 'Kurze Sätze verwenden.' } })).status, 200);
  const rest = (await srv.call('GET', `/api/learning/learned?client_id=${cl.id}`, { token: A() })).body[0].saetze.map(x => x.text);
  assert.deepEqual(rest, ['Warm schreiben.', 'Immer mit Vornamen anreden.']);
  // Fremder Klient ist nicht betroffen, letzter Satz löscht die Zeile
  assert.equal((await learnings(other.id)).length, 0);
  await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: A(), body: { text: 'Warm schreiben.' } });
  await srv.call('POST', `/api/learning/learned/${id}/forget`, { token: A(), body: { text: 'Immer mit Vornamen anreden.' } });
  assert.equal((await learnings(cl.id)).length, 0);
});
