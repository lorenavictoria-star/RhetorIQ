// Vergleich Entwurf und Endtext: Speicherung beim Erzeugen mit zweitem Durchgang, Auswertung, Zugriff.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = require('../db');
const dg = require('../lib/durchgang');

const REF = 'Guten Tag zusammen. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit. Gerne beantworten wir Ihre Fragen rasch und persönlich.\n\nUnser Team berät Sie ehrlich und verbindlich. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit.\n\nSie erhalten von uns eine klare Offerte. Gerne beantworten wir Ihre Fragen rasch und persönlich.';
const ENTWURF = 'Hey, du solltest unbedingt bedenken, dass die disruptive Skalierung deiner Wertschöpfungsarchitektur im Kontext volatiler Marktdynamiken eine konsequente Neuausrichtung sämtlicher operativer Kernprozesse erfordert, weil dein Wettbewerbsumfeld ansonsten schneller transformiert wird, als irgendein Steuerungsgremium reagieren kann.';
const ENDTEXT = 'Guten Tag. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit. Unser Team berät Sie ehrlich und verbindlich bei jeder Frage.\n\nGerne beantworten wir Ihre Fragen rasch und persönlich. Sie erhalten von uns eine klare Offerte innert zwei Tagen.';

let srv, a;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  a = await H.addClient('Alpha AG');
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'ref_tg_email',$2)`, [a.id, REF]);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')], ['/api/messung', require('../routes/messung')]]);
});
test.after(async () => { await srv.close(); });

const warte = async (fn) => { for (let i = 0; i < 40; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return null; };

test('Erzeugen mit zweitem Durchgang speichert Entwurf, Endtext und Kennzahlen', async () => {
  H.ai.reply = (opts) => (JSON.stringify(opts.messages).includes('ENTWURF (erster Versuch)') ? ENDTEXT : ENTWURF);
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', clientId: a.id, data: { text: 'Einladung', tile: 'email' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, ENDTEXT);
  const row = await warte(async () => (await pool.query('SELECT * FROM durchgang_vergleich WHERE analysis_id=$1', [r.body.id])).rows[0]);
  assert.ok(row, 'Vergleich gespeichert');
  assert.equal(row.entwurf, ENTWURF);
  assert.equal(row.endtext, ENDTEXT);
  assert.ok(Number(row.aenderungsanteil) >= 0.9);
  assert.ok(row.stimmnaehe_nachher - row.stimmnaehe_vorher >= 30);
});

test('ohne zweiten Durchgang (thorough:false) wird nichts gespeichert', async () => {
  const vorher = (await pool.query('SELECT COUNT(*)::int AS n FROM durchgang_vergleich')).rows[0].n;
  H.ai.reply = ENDTEXT;
  const r = await srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', clientId: a.id, thorough: false, data: { text: 'Einladung', tile: 'email' } } });
  assert.equal(r.status, 200);
  await new Promise(x => setTimeout(x, 150));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM durchgang_vergleich')).rows[0].n, vorher);
});

test('vergleiche: gleiche Fassung ergibt keine Änderung; Lint nur, wenn lib/lint.js existiert', () => {
  const v = dg.vergleiche(ENDTEXT, ENDTEXT, [REF], 'text-gen');
  assert.equal(v.aenderungsanteil, 0);
  assert.equal(v.stimmVorher, v.stimmNachher);
  const lintVorhanden = (() => { try { require('../lib/lint'); return true; } catch { return false; } })();
  assert.equal(v.lintVorher === null, !lintVorhanden || typeof require('../lib/lint').lintText !== 'function');
});

test('Auswertung: Durchschnitt, wesentliche Änderungen, nur eigene Beraterin, Zugriff', async () => {
  await pool.query('DELETE FROM durchgang_vergleich');
  const ins = (adv, aend, sv, sn) => pool.query(`INSERT INTO durchgang_vergleich (advisor_id, module, aenderungsanteil, stimmnaehe_vorher, stimmnaehe_nachher) VALUES ($1,'text-gen',$2,$3,$4)`, [adv, aend, sv, sn]);
  await ins(1, 0.5, 50, 60); await ins(1, 0.05, 70, 72); await ins(1, 0.3, 40, 52); await ins(2, 0.9, 10, 90);
  const r = await srv.call('GET', '/api/messung/durchgang?days=90', { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.equal(r.body.anzahl, 3);
  assert.deepEqual([r.body.wesentlich.anzahl, r.body.wesentlich.von, r.body.wesentlich.prozent], [2, 3, 67]);
  assert.equal(r.body.stimmnaehe.differenz, 8);
  assert.equal(r.body.zwischenstand, true);
  assert.match(r.body.satz, /In 2 von 3 Texten \(67 Prozent\) hat der zweite Durchgang den Entwurf wesentlich verändert\. Die Stimmnähe stieg im Schnitt um 8 Punkte\./);
  assert.equal((await srv.call('GET', '/api/messung/durchgang', { token: H.clientToken(a.id) })).status, 403);
});
