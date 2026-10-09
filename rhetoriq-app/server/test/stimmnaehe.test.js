// Stimmnähe: lokale Messung gegen das Referenzmaterial, Speicherung, Zugriff.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const sn = require('../lib/stimmnaehe');

// Referenz: kurze Sätze, Sie-Form, Wiederholung typischer Wendungen, Absätze mit zwei Sätzen
const REF1 = 'Guten Tag zusammen. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit. Gerne beantworten wir Ihre Fragen rasch und persönlich.\n\nUnser Team berät Sie ehrlich und verbindlich. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit.\n\nSie erhalten von uns eine klare Offerte. Gerne beantworten wir Ihre Fragen rasch und persönlich.';
const REF2 = 'Danke für Ihr Vertrauen in unser Team. Wir beraten Sie ehrlich und verbindlich bei jeder Frage.\n\nWir freuen uns auf Ihre Anfrage zur Zusammenarbeit. Sie erhalten von uns eine klare Offerte innert zwei Tagen.\n\nGerne beantworten wir Ihre Fragen rasch und persönlich. Ihr Team berät Sie ehrlich.';
const REFS = [REF1, REF2];
// Nah: gleiche Sprache, Sie-Form, kurze Sätze, ähnliche Wendungen
const NAH = 'Guten Tag. Wir freuen uns auf Ihre Anfrage zur Zusammenarbeit. Unser Team berät Sie ehrlich und verbindlich bei jeder Frage.\n\nGerne beantworten wir Ihre Fragen rasch und persönlich. Sie erhalten von uns eine klare Offerte innert zwei Tagen.';
// Fern: ein einziger langer Satz im Du, anderer Wortschatz, kein Absatz
const FERN = 'Hey, du solltest unbedingt bedenken, dass die disruptive Skalierung deiner Wertschöpfungsarchitektur im Kontext volatiler Marktdynamiken eine konsequente Neuausrichtung sämtlicher operativer Kernprozesse erfordert, weil dein Wettbewerbsumfeld ansonsten schneller transformiert wird, als irgendein Steuerungsgremium reagieren kann, und deshalb solltest du dir überlegen, welche Hebel du priorisierst, damit deine Organisation resilient bleibt.';

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'ref_tg_email',$2),($1,'ref_brand_voice_source',$3)`, [a.id, REF1, REF2]);
  srv = await H.startApp([['/api/stimmnaehe', require('../routes/stimmnaehe')]]);
});
test.after(async () => { await srv.close(); });

test('Gewichte ergeben zusammen 1', () => {
  assert.ok(Math.abs(Object.values(sn.GEWICHTE).reduce((x, y) => x + y, 0) - 1) < 1e-9);
});

test('naher Text liegt klar über dem fernen Text', () => {
  const nah = sn.stimmnaehe(NAH, REFS), fern = sn.stimmnaehe(FERN, REFS);
  assert.ok(nah && fern);
  assert.ok(nah.wert >= 70, 'nah: ' + nah.wert);
  assert.ok(fern.wert <= 40, 'fern: ' + fern.wert);
  assert.ok(nah.wert - fern.wert >= 30);
  assert.equal(nah.merkmale.anrede.naehe, 1);
  assert.equal(fern.merkmale.anrede.naehe, 0);
});

test('zu kurzer Text oder zu wenig Referenz ergibt keinen Wert', () => {
  assert.equal(sn.stimmnaehe('Kurz und knapp.', REFS), null);
  assert.equal(sn.stimmnaehe(NAH, ['Zu wenig.']), null);
});

test('Referenzmaterial stammt aus company_memory, Speicherung und Monatsdurchschnitt', async () => {
  const refs = await sn.referenzTexte(a.id);
  assert.equal(refs.length, 2);
  const { rows } = await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, result) VALUES ($1,1,'text-gen',$2) RETURNING id`, [a.id, NAH]);
  const w = await sn.fuerAnalyse(rows[0].id, a.id, 'text-gen', NAH);
  assert.ok(w >= 70);
  await sn.fuerAnalyse(rows[0].id, a.id, 'text-gen', NAH);   // zweites Mal: aktualisiert statt doppelt
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM stimmnaehe WHERE analysis_id=$1', [rows[0].id])).rows[0].n, 1);
  assert.equal(await sn.fuerAnalyse(rows[0].id, a.id, 'rp', NAH), null);   // Analyse-Modul: nicht gemessen
  await sn.fuerFreigabe({ id: 5, client_id: a.id, edited_text: FERN });
  const m = await sn.monatsDurchschnitt(a.id, 3);
  assert.equal(m.length, 3);
  assert.equal(m[2].erzeugt.anzahl, 1);
  assert.equal(m[2].gesendet.anzahl, 1);
  assert.ok(m[2].gesendet.schnitt < m[2].erzeugt.schnitt);
});

test('Endpunkte: nur Beraterin, fremde Klienten gesperrt', async () => {
  const { rows } = await pool.query(`SELECT id FROM analyses WHERE client_id=$1 LIMIT 1`, [a.id]);
  const ok = await srv.call('GET', `/api/stimmnaehe/analyse/${rows[0].id}`, { token: H.advisorToken() });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.wert >= 70 && ok.body.merkmale.wortschatz);
  assert.equal((await srv.call('GET', `/api/stimmnaehe/analyse/${rows[0].id}`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/stimmnaehe/${a.id}`, { token: H.clientToken(a.id) })).status, 403);
  const mo = await srv.call('GET', `/api/stimmnaehe/${a.id}`, { token: H.advisorToken() });
  assert.equal(mo.status, 200);
  assert.equal(mo.body.monate.length, 6);
  assert.equal((await srv.call('GET', `/api/stimmnaehe/analyse/99999`, { token: H.advisorToken() })).status, 404);
});
