// Ein Lernweg (Aufgabe 7): Herkunft der gelernten Sätze und Erkennung von Widersprüchen.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');   // zuerst: ersetzt die Datenbank durch pg-mem
const L = require('../lib/lernquellen');

const item = (text, extra = {}) => ({ module_key: 'text-gen-email', category: 'TON', text, ...extra });
const konflikte = (...texte) => L.findeKonflikte(texte.map(t => item(t))).map(k => k.thema);

test('Gegensatzpaare: kürzer gegen länger, formeller gegen lockerer, du gegen Sie', () => {
  assert.deepEqual(konflikte('Schreibe kürzer.', 'Schreibe ausführlicher.'), ['Textlänge']);
  assert.deepEqual(konflikte('Der Ton soll formeller sein.', 'Der Ton soll lockerer sein.'), ['Formalität']);
  assert.deepEqual(konflikte('Sprich den Klienten mit Du an.', 'Die Anrede erfolgt mit Sie.'), ['Anrede']);
  assert.deepEqual(konflikte('Duze die Empfänger.', 'Siezen ist verlangt.'), ['Anrede']);
  assert.deepEqual(konflikte('Schreibe wärmer und herzlicher.', 'Schreibe nüchtern und distanziert.'), ['Wärme']);
  assert.deepEqual(konflikte('Komm direkt zur Sache.', 'Formuliere diplomatisch und zurückhaltend.'), ['Direktheit']);
  assert.deepEqual(konflikte('Kurze Sätze bevorzugen.', 'Längere Sätze mit Nebensätzen sind erwünscht.'), ['Satzlänge']);
});

test('Verneinung dreht den Pol: Emojis verwenden gegen keine Emojis, nicht zu formell gegen locker', () => {
  assert.deepEqual(konflikte('Setze Emojis ein.', 'Keine Emojis verwenden.'), ['Emojis']);
  assert.deepEqual(konflikte('Nie Ausrufezeichen setzen.', 'Ausrufezeichen sind erwünscht.'), ['Ausrufezeichen']);
  assert.deepEqual(konflikte('Der Ton darf nicht zu formell sein.', 'Der Ton soll locker sein.'), [], 'beides zielt in dieselbe Richtung');
  assert.deepEqual(konflikte('Der Ton darf nicht zu formell sein.', 'Der Ton soll formell sein.'), ['Formalität']);
});

test('Kein Widerspruch: gleiche Richtung, verschiedene Themen, andere Kategorie oder andere Textart', () => {
  assert.deepEqual(konflikte('Schreibe kürzer.', 'Fasse dich knapp.'), []);
  assert.deepEqual(konflikte('Schreibe kürzer.', 'Sprich den Klienten mit Du an.'), []);
  assert.deepEqual(konflikte('Kurze Sätze bevorzugen.', 'Schreibe ausführlicher.'), [], 'Satzlänge und Textlänge sind verschiedene Themen');
  assert.deepEqual(L.findeKonflikte([item('Schreibe kürzer.'), item('Schreibe ausführlicher.', { category: 'STRUKTUR' })]), []);
  assert.deepEqual(L.findeKonflikte([item('Schreibe kürzer.'), item('Schreibe ausführlicher.', { module_key: 'text-gen-linkedin' })]), []);
  assert.deepEqual(konflikte('Schreibe kürzer, aber nicht zu knapp, und ausführlich bei Zahlen.'), [], 'ein Satz allein ist nie ein Widerspruch');
});

test('anreichern: Herkunft und Konflikt je Satz, beidseitig mit dem Gegenstück', () => {
  const rows = [{ module_key: 'text-gen-email', category: 'TON', satz_meta: { 'schreibe kürzer.': { herkunft: 'klient' }, 'schreibe ausführlicher.': { herkunft: 'korrektur' } } }];
  const saetze = [[{ text: 'Schreibe kürzer.' }, { text: 'Schreibe ausführlicher.' }, { text: 'Sei freundlich.' }]];
  L.anreichern(rows, saetze);
  const [a, b, c] = saetze[0];
  assert.equal(a.herkunftText, 'aus Rückmeldung des Klienten');
  assert.equal(b.herkunftText, 'aus deiner Korrektur');
  assert.equal(c.herkunft, null);
  assert.deepEqual(a.konflikt, { thema: 'Textlänge', mit: ['Schreibe ausführlicher.'] });
  assert.deepEqual(b.konflikt, { thema: 'Textlänge', mit: ['Schreibe kürzer.'] });
  assert.equal(c.konflikt, null);
});

// ── Ende zu Ende: beide Wege schreiben, die Anzeige kennzeichnet, «Behalten» löst den Widerspruch ──
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

async function waitFor(fn) {
  for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); }
  return null;
}

test('Beide Wege: Daumen-Notiz des Klienten und angenommene Korrektur erscheinen mit Herkunft, der Widerspruch ist markiert', async () => {
  const cl = await H.addClient('Quellen AG');
  const { rows: an } = await H.pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result, feedback_key) VALUES ($1,1,'text-gen','Text','Ergebnis','text-gen-email') RETURNING id`, [cl.id]);
  // Weg A: Rückmeldung des Klienten (Daumen mit Notiz), verdichtet von der KI-Attrappe
  H.ai.fail = false;
  H.ai.reply = 'KATEGORIE: TON\nZUSAMMENFASSUNG: Der Text soll kürzer sein.';
  const r = await srv.call('POST', `/api/analyze/${an[0].id}/rate`, { token: H.clientToken(cl.id), body: { rating: -1, note: 'zu lang' } });
  assert.equal(r.status, 200);
  const row = await waitFor(async () => (await H.pool.query('SELECT * FROM client_feedback_learnings WHERE client_id=$1', [cl.id])).rows[0]);
  assert.ok(row, 'Weg A hat gelernt');
  // Weg B: Vorschlag aus der Korrektur der Beraterin, angenommen
  const { rows: sg } = await H.pool.query(
    `INSERT INTO learning_suggestions (client_id, module_key, module_label, category, observation, occurrences, status) VALUES ($1,'text-gen-email','E-Mail','TON','Schreibe ausführlicher.',2,'offen') RETURNING id`, [cl.id]);
  const acc = await srv.call('POST', `/api/learning/${sg[0].id}/accept`, { token: A(), body: {} });
  assert.equal(acc.status, 200);
  const list = await srv.call('GET', `/api/learning/learned?client_id=${cl.id}`, { token: A() });
  assert.equal(list.status, 200);
  const saetze = list.body[0].saetze;
  const klient = saetze.find(s => /kürzer/.test(s.text)), korr = saetze.find(s => /ausführlicher/.test(s.text));
  assert.equal(klient.herkunft, 'klient');
  assert.equal(klient.herkunftText, 'aus Rückmeldung des Klienten');
  assert.equal(korr.herkunft, 'korrektur');
  assert.equal(korr.herkunftText, 'aus deiner Korrektur');
  assert.equal(klient.konflikt.thema, 'Textlänge');
  assert.deepEqual(klient.konflikt.mit, [korr.text]);
  assert.deepEqual(korr.konflikt.mit, [klient.text]);

  // «Behalten»: nur die eigene Beraterin, der widersprechende Satz wird vergessen
  const id = list.body[0].id;
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/keep`, { token: H.clientToken(cl.id), body: { text: korr.text } })).status, 403);
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/keep`, { token: A(), body: {} })).status, 400);
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/keep`, { token: A(), body: { text: 'Gibt es nicht.' } })).status, 404);
  const keep = await srv.call('POST', `/api/learning/learned/${id}/keep`, { token: A(), body: { text: korr.text } });
  assert.equal(keep.status, 200);
  assert.equal(keep.body.vergessen, 1);
  const after = await srv.call('GET', `/api/learning/learned?client_id=${cl.id}`, { token: A() });
  assert.deepEqual(after.body[0].saetze.map(s => s.text), [korr.text]);
  assert.equal(after.body[0].saetze[0].konflikt, null);
  assert.equal(after.body[0].saetze[0].herkunft, 'korrektur');
  // ohne Widerspruch gibt es nichts zu entscheiden
  assert.equal((await srv.call('POST', `/api/learning/learned/${id}/keep`, { token: A(), body: { text: korr.text } })).status, 409);
});

test('Verdichtung durch den Klienten behält die Herkunft eines ähnlichen Korrektursatzes', async () => {
  const cl = await H.addClient('Verdichtung AG');
  await H.pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary) VALUES ($1,'text-gen-email','TON','Schreibe warm und persönlich.')`, [cl.id]);
  await L.markiereHerkunft(cl.id, 'text-gen-email', 'TON', 'korrektur');
  const merk = await L.vorMerken(cl.id, 'text-gen-email', 'TON');
  await H.pool.query(`UPDATE client_feedback_learnings SET summary='Schreibe warm, persönlich und freundlich. Fasse dich kurz.' WHERE client_id=$1`, [cl.id]);
  await L.nachMerken(merk, 'klient');
  const { rows } = await H.pool.query('SELECT satz_meta FROM client_feedback_learnings WHERE client_id=$1', [cl.id]);
  const meta = rows[0].satz_meta;
  assert.equal(meta['schreibe warm, persönlich und freundlich.'].herkunft, 'korrektur');
  assert.equal(meta['fasse dich kurz.'].herkunft, 'klient');
});
