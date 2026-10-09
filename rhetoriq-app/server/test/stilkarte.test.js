// Stilkarte (Aufgabe 8): lokale Kennzahlen, Speicherung als kind 'stilkarte', drei Zeilen im Auftrag, Endpunkt.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate, systemText } = require('../test-support/genSetup');
const SK = require('../lib/stilkarte');

const TEXTE = [
  'Guten Tag Frau Keller. Wir danken Ihnen für Ihre Anfrage. Gerne senden wir Ihnen die Unterlagen zu.\n\nBei Fragen melden Sie sich jederzeit bei uns. Wir freuen uns auf das Gespräch mit Ihnen.',
  'Guten Tag Herr Meier. Vielen Dank für Ihre Nachricht. Wir prüfen den Termin und melden uns heute noch bei Ihnen.\n\nFreundliche Grüsse aus Winterthur und bis bald.',
  'Guten Tag Frau Huber. Wir haben Ihre Unterlagen erhalten. Wir prüfen alles und melden uns bei Ihnen mit einem klaren Vorschlag, der zu Ihrem Vorhaben passt.',
  'Guten Tag Herr Frei. Danke für Ihr Interesse. Wir melden uns bei Ihnen, sobald wir den Termin bestätigen können, und senden Ihnen dann alles zu.'
];

test('berechne: Satzlänge, Anteil kurzer Sätze, Anrede, Wendungen, Absatzlänge', () => {
  const k = SK.berechne(TEXTE);
  assert.ok(k.satzlaenge > 5 && k.satzlaenge < 25);
  assert.ok(k.kurzeSaetze >= 0 && k.kurzeSaetze <= 100);
  assert.equal(k.anrede, 'Sie');
  assert.ok(k.absatzSaetze >= 1);
  assert.equal(k.texte, 4);
  assert.ok(Array.isArray(k.wendungen) && k.wendungen.length <= 3);
  const z = SK.zeilen(k);
  assert.equal(z.length, 5);
  assert.ok(z[0].startsWith('Durchschnittliche Satzlänge: '));
  assert.ok(z[2].includes('Anrede: Sie'));
});

test('berechne: zu wenige oder zu kurze Texte ergeben keine Karte, Du-Anrede wird erkannt', () => {
  assert.equal(SK.berechne(TEXTE.slice(0, 2)), null);
  assert.equal(SK.berechne(['Hallo. Ja.', 'Kurz', 'Nein']), null);
  const du = ['Hallo Anna. Ich schicke dir die Unterlagen und melde mich bei dir, sobald ich Zeit habe.', 'Hallo Beat. Danke für deine Nachricht, ich rufe dich morgen an und wir klären alles.', 'Hallo Carla. Hast du schon Zeit gehabt? Ich warte auf deine Antwort und freue mich darauf.'];
  assert.equal(SK.berechne(du).anrede, 'du');
});

test('auftragsZeilen: höchstens drei Zeilen und 400 Zeichen, auch mit langen Wendungen', () => {
  const k = SK.berechne(TEXTE);
  const z = SK.auftragsZeilen(k);
  assert.ok(z.startsWith('Stilkarte des Klienten: '));
  assert.ok(z.split('\n').length <= 3);
  assert.ok(z.length <= SK.MAX_ZEICHEN);
  const lang = SK.auftragsZeilen({ ...k, wendungen: ['x'.repeat(200), 'y'.repeat(200), 'z'.repeat(200)] });
  assert.ok(lang.length <= SK.MAX_ZEICHEN);
  assert.ok(lang.includes('Absätze im Schnitt'));
  assert.equal(SK.auftragsZeilen(null), '');
});

let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  srv = await H.startApp([
    ['/api/analyze', require('../routes/analyze')],
    ['/api/stilkarte', require('../routes/stilkarte')]
  ]);
});
test.after(async () => { await srv.close(); });

async function freigaben(clientId, texte) {
  for (const t of texte) await H.pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status) VALUES ($1,'E-Mail',$2,$2,'approved')`, [clientId, t]);
}

test('holeKarte: berechnet aus den Freigaben, speichert als kind stilkarte und nutzt die Karte eine Woche lang', async () => {
  const cl = await H.addClient('Karte AG');
  assert.equal(await SK.holeKarte(cl.id), null, 'ohne Texte keine Karte');
  await freigaben(cl.id, TEXTE);
  const r = await SK.holeKarte(cl.id);
  assert.equal(r.karte.texte, 4);
  const { rows } = await H.pool.query(`SELECT kind, metrics FROM communication_profiles WHERE client_id=$1`, [cl.id]);
  assert.deepEqual(rows.map(x => x.kind), ['stilkarte']);
  // Neue Texte ändern die Karte innerhalb einer Woche nicht (aus dem Speicher)
  await freigaben(cl.id, TEXTE.slice(0, 1));
  assert.equal((await SK.holeKarte(cl.id)).karte.texte, 4);
  assert.equal((await H.pool.query(`SELECT COUNT(*)::int AS n FROM communication_profiles WHERE client_id=$1`, [cl.id])).rows[0].n, 1);
  // Nach einer Woche wird neu berechnet
  const spaeter = new Date(Date.now() + 8 * 86400000);
  assert.equal((await SK.holeKarte(cl.id, spaeter)).karte.texte, 5);
});

test('Auftrag: Stilkarte steht im dynamischen Teil bei Textarten, nicht bei Analysemodulen', async () => {
  const cl = await H.addClient('Auftrag AG');
  await freigaben(cl.id, TEXTE);
  H.ai.calls.length = 0;
  H.ai.reply = 'Ein kurzer Text.';
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', clientId: cl.id, data: { text: 'Mail an Kundschaft' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const blocks = H.ai.calls[0].system;
  const idx = blocks.findIndex(b => b.text.includes('Stilkarte des Klienten:'));
  assert.ok(idx > 0, 'Stilkarte vorhanden');
  assert.ok(!blocks[0].text.includes('Stilkarte des Klienten'), 'nicht im gecachten Basisblock');
  const zeilen = systemText(H.ai.calls[0]).split('\n').filter(l => l.startsWith('Stilkarte des Klienten:'));
  assert.equal(zeilen.length, 1);
  H.ai.calls.length = 0;
  const rm = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'rm', clientId: cl.id, data: { text: 'Pressetext hier' } } });
  H.ai.reply = '{}';
  assert.equal(rm.status, 200);
  assert.ok(!systemText(H.ai.calls[0]).includes('Stilkarte des Klienten'));
});

test('Endpunkt: Beraterin und eigener Klient lesen, fremde Klienten nicht', async () => {
  const cl = await H.addClient('Endpunkt AG');
  const other = await H.addClient('Fremd AG');
  await freigaben(cl.id, TEXTE);
  const ok = await srv.call('GET', `/api/stilkarte/${cl.id}`, { token: H.advisorToken() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.zeilen.length, 5);
  assert.equal((await srv.call('GET', `/api/stilkarte/${cl.id}`, { token: H.clientToken(cl.id) })).status, 200);
  assert.equal((await srv.call('GET', `/api/stilkarte/${cl.id}`, { token: H.clientToken(other.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/stilkarte/${cl.id}`)).status, 401);
  const leer = await srv.call('GET', `/api/stilkarte/${other.id}`, { token: H.advisorToken() });
  assert.deepEqual(leer.body.zeilen, []);
});
