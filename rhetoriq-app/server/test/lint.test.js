// Lokaler Lint (Aufgabe 3): jede Trefferart, Anrede, Sprache, Prüfauftrag, Einbindung in beide Durchgänge.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/lint');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');

const arten = (text, o) => L.lintText(text, o).map(h => h.art);

test('Gedankenstriche (Halbgeviert- und Geviertstrich) mit Position', () => {
  const hits = L.lintText('Gut – sehr gut — oder?');
  assert.deepEqual(hits.map(h => h.art), ['gedankenstrich', 'gedankenstrich']);
  assert.equal(hits[0].pos, 4);
  assert.equal(hits[1].pos, 15);
  assert.deepEqual(arten('Ein Bindestrich - mit Leerzeichen ist erlaubt.'), []);
});

test('Eszett nur bei Deutsch', () => {
  assert.deepEqual(arten('Liebe Grüße'), ['eszett']);
  assert.deepEqual(arten('Liebe Grüße', { sprache: 'Deutsch' }), ['eszett']);
  assert.deepEqual(arten('Liebe Grüße', { sprache: 'English' }), []);
  assert.deepEqual(arten('Liebe Grüsse'), []);
});

test('Floskeln und Füllwort (nur gemeldet, weich)', () => {
  const hits = L.lintText('In der heutigen schnelllebigen Welt freuen wir uns. Wir freuen uns, Ihnen mitteilen zu dürfen, dass es klappt. We hope this message finds you well. Das bringt Mehrwert.');
  assert.equal(hits.filter(h => h.art === 'floskel').length, 3);
  const w = hits.find(h => h.art === 'fuellwort');
  assert.ok(w && w.weich === true);
  // Weiche Treffer kommen nicht in den Prüfauftrag
  assert.ok(!L.pruefAuftragAusTreffern([w]));
});

test('Gegenüberstellung «nicht X, sondern Y», aber nicht «nicht nur ... sondern auch»', () => {
  assert.deepEqual(arten('Das ist nicht teuer, sondern klug.'), ['gegenueberstellung']);
  assert.deepEqual(arten('Das ist nicht nur klug, sondern auch günstig.'), []);
});

test('Anrede: gemischt, mit vorgegebener Anrede und ohne Pronomen am Satzanfang', () => {
  assert.deepEqual(arten('Wir danken Ihnen. Hast du Zeit? Wir senden Ihnen die Unterlagen.'), ['anrede']);   // Du-Form ist die Minderheit
  const sieText = 'Wir melden uns bei Ihnen und Sie bekommen Post. Dein Termin steht.';
  assert.deepEqual(L.lintText(sieText, { anrede: 'sie' }).map(h => h.text), ['Dein']);
  assert.deepEqual(L.lintText('Ich schicke dir Post. Wir melden uns bei Ihnen.', { anrede: 'du' }).map(h => h.text), ['Ihnen']);
  assert.deepEqual(arten('Sie kommt morgen. Sie hat Zeit.'), [], 'Sie am Satzanfang ist mehrdeutig');
  assert.deepEqual(arten('Wir danken Ihnen sehr.', { anrede: 'sie' }), []);
  assert.deepEqual(arten('Hast du dich gemeldet? Das hilft dir.', { sprache: 'English' }), []);
  assert.equal(L.anredeAusTon('Geschäftlich · Du'), 'du');
  assert.equal(L.anredeAusTon('Geschäftlich · Sie'), 'sie');
});

test('Gendern mit Sonderzeichen: Stern, Doppelpunkt, Unterstrich, Schrägstrich, Binnen-I', () => {
  for (const t of ['Kund*innen', 'Kund:innen', 'Kund_innen', 'Mitarbeiter/innen', 'MitarbeiterInnen', 'Experte:in']) {
    assert.deepEqual(arten('Liebe ' + t + ' bitte lesen'), ['gendern'], t);
  }
  assert.deepEqual(arten('Kundinnen und Kunden'), []);
  assert.deepEqual(arten('Die Innenstadt'), []);
});

test('Markdown: Fettschrift, Überschrift, Stern-Aufzählung, Trennlinie, Tabelle, Backticks; Strich-Aufzählung bleibt erlaubt', () => {
  const md = '# Titel\nText mit **fett** und `code`.\n* Punkt\n---\n| a | b |\n';
  const wasList = L.lintText(md).map(h => h.was);
  for (const w of ['Überschrift mit Doppelkreuz', 'Fettschrift mit Sternchen', 'Backticks', 'Aufzählungszeichen', 'Trennlinie', 'Tabelle']) assert.ok(wasList.includes(w), w);
  assert.deepEqual(arten('PUNKTE:\n- eins\n- zwei'), []);
});

test('Sauberer Text liefert keine Treffer, Treffer sind nach Position sortiert', () => {
  assert.deepEqual(L.lintText('Guten Tag, wir melden uns morgen bei Ihnen.', { anrede: 'sie' }), []);
  assert.deepEqual(L.lintText(''), []);
  const hits = L.lintText('b ß a – c');
  assert.deepEqual(hits.map(h => h.pos), [2, 6]);
});

test('Prüfauftrag und Zusammenfassung', () => {
  const hits = L.lintText('Gut – sehr. Liebe Grüße');
  const auftrag = L.pruefAuftragAusTreffern(hits);
  assert.ok(auftrag.includes('Behebe genau diese Punkte'));
  assert.ok(auftrag.includes('Gedankenstrich'));
  assert.ok(!/[–—]\s*$/.test(auftrag.split('\n')[0]));
  const z = L.lintZusammenfassung(hits);
  assert.equal(z.n, 2);
  assert.equal(z.text, 'Prüfhinweis: 2 Stellen (Gedankenstrich, ß)');
  assert.equal(L.lintZusammenfassung([]), null);
  assert.equal(L.lintZusammenfassung(L.lintText('Ein Fehler – ja')).text, 'Prüfhinweis: 1 Stelle (Gedankenstrich)');
  assert.deepEqual(L.lintOptionenAusDaten({ language: 'Deutsch', tone: 'Geschäftlich · Du' }), { sprache: 'Deutsch', anrede: 'du' });
});

// Einbindung: Der zweite Durchgang bleibt Standard und bekommt die Treffer des Entwurfs
let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

test('POST /: Treffer im Entwurf gehen in den zweiten Durchgang, Rest erscheint als Prüfhinweis', async () => {
  H.ai.calls.length = 0;
  let n = 0;
  H.ai.reply = () => (++n === 1 ? 'Guten Tag – wir melden uns. Liebe Grüße' : 'Guten Tag, wir melden uns. Liebe Grüße');
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', data: { text: 'Kurze Mail', language: 'Deutsch' } } });
  H.ai.reply = '{}';
  assert.equal(r.status, 200);
  assert.equal(H.ai.calls.length, 2, 'zwei Durchgänge bleiben Standard');
  const zweiter = JSON.stringify(H.ai.calls[1].messages);
  assert.ok(zweiter.includes('Behebe genau diese Punkte'));
  assert.ok(zweiter.includes('Gedankenstrich'));
  assert.ok(!JSON.stringify(H.ai.calls[0].messages).includes('Behebe genau diese Punkte'));
  assert.equal(r.body.lint.n, 1);
  assert.equal(r.body.lint.text, 'Prüfhinweis: 1 Stelle (ß)');
});

test('POST /: ohne Treffer kein Prüfauftrag und kein Hinweis', async () => {
  H.ai.calls.length = 0;
  H.ai.reply = 'Guten Tag, wir melden uns.';
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', data: { text: 'Kurze Mail', language: 'Deutsch' } } });
  H.ai.reply = '{}';
  assert.equal(H.ai.calls.length, 2);
  assert.ok(!JSON.stringify(H.ai.calls[1].messages).includes('Behebe genau diese Punkte'));
  assert.equal(r.body.lint, null);
});
