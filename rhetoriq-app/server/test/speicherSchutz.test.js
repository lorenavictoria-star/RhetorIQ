// Geschützte Speicherung (lib/speicherSchutz.js) und Löschfrist je Klient (lib/retention.js leereAlteTexte).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

const IBAN = 'CH93 0076 2011 6238 5295 7';

test('Speicherschutz: Modus «ersetzen» speichert Platzhalter, «warnen» lässt den Text unverändert', async () => {
  await H.setupBase();
  const store = require('../lib/datenwaechterStore');
  const { schuetzeAlle } = require('../lib/speicherSchutz');
  await store.speichereEinstellungen({ modus: 'ersetzen', typen: ['IBAN'] });
  const [data, result, zahl] = await schuetzeAlle({ text: `Bitte auf ${IBAN} zahlen`, n: 3 }, `Konto ${IBAN} bestätigt`, 7);
  assert.ok(!data.text.includes('0076'), 'IBAN in der Eingabe ersetzt');
  assert.ok(!result.includes('0076'), 'IBAN im Ergebnis ersetzt');
  const ph = data.text.match(/\[IBAN-\d+\]/);
  assert.ok(ph, 'Platzhalter vorhanden');
  assert.ok(result.includes(ph[0]), 'gleicher Wert, gleicher Platzhalter in Eingabe und Ergebnis');
  assert.equal(data.n, 3); assert.equal(zahl, 7);

  await store.speichereEinstellungen({ modus: 'warnen', typen: ['IBAN'] });
  const [roh] = await schuetzeAlle({ text: `Bitte auf ${IBAN} zahlen` });
  assert.ok(roh.text.includes('0076'), 'im Modus «warnen» unverändert');

  await store.speichereEinstellungen({ modus: 'sperren', typen: ['IBAN'] });
  const [gesperrt] = await schuetzeAlle(`IBAN ${IBAN}`);
  assert.ok(!gesperrt.includes('0076'), 'auch im Modus «sperren» geschützt gespeichert');
  await store.speichereEinstellungen({ modus: 'warnen', typen: ['IBAN'] });
});

test('Löschfrist je Klient: ältere Texte werden geleert, neuere und Klienten ohne Frist bleiben', async () => {
  await pool.query('ALTER TABLE clients ADD COLUMN aufbewahrung_tage INTEGER');
  await pool.query(`CREATE TABLE module_examples (id SERIAL PRIMARY KEY, source_client_id INTEGER, auto_generated BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const { leereAlteTexte } = require('../lib/retention');
  const mk = async (name, tage) => (await pool.query(`INSERT INTO clients (advisor_id, name, slug, token, email, aufbewahrung_tage) VALUES (1,$1,$1,$1,$2,$3) RETURNING id`, [name, name + '@x.ch', tage])).rows[0].id;
  const a = await mk('mitfrist', 30), b = await mk('ohnefrist', null);
  const day = (n) => new Date(Date.now() - n * 86400000);
  const an = async (cid, alter) => (await pool.query(
    `INSERT INTO analyses (client_id, advisor_id, module, input_data, result, created_at) VALUES ($1,1,'text-gen',$2,'Geheim',$3) RETURNING id`,
    [cid, JSON.stringify({ text: 'Geheim' }), day(alter)])).rows[0].id;
  await pool.query(`INSERT INTO module_examples (source_client_id, auto_generated, created_at) VALUES ($1,true,$2),($1,true,$3)`, [a, day(60), day(5)]);
  const alt = await an(a, 60), neu = await an(a, 5), frei = await an(b, 400);
  const n = await leereAlteTexte();
  const get = async (id) => (await pool.query('SELECT input_data, result FROM analyses WHERE id=$1', [id])).rows[0];
  assert.equal(n, 1);
  assert.deepEqual(await get(alt), { input_data: null, result: null });
  assert.equal((await get(neu)).result, 'Geheim');
  assert.equal((await get(frei)).result, 'Geheim');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM module_examples')).rows[0].n, 1, 'altes automatisches Beispiel gelöscht');
});
