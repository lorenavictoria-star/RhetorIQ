// Restaurants (Betriebe) eines Klienten: anlegen, ändern, Rechte, und das Stimmprofil fliesst in die Texterstellung ein.
process.env.ABO_PFLICHT_AB = '2099-01-01T00:00:00Z';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;

let srv, a, b, c;
const adv = () => H.advisorToken();
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query('CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  for (const col of ['capital_markets_enabled BOOLEAN DEFAULT FALSE', 'hotel_enabled BOOLEAN DEFAULT FALSE']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  a = await H.addClient('Segmüller Collection');
  b = await H.addClient('Andere AG');
  c = await H.addClient('Ohne Restaurants AG');
  for (const k of [a, b]) await pool.query('UPDATE clients SET enabled_modules=$1 WHERE id=$2', [['brand-voice', 'text-gen', 'restaurants'], k.id]);
  srv = await H.startApp([
    ['/api/einheiten', require('../routes/einheiten')],
    ['/api/analyze', require('../routes/analyze')]
  ]);
  H.ai.reply = 'Ein kurzer Text.';
});
test.after(async () => { await srv.close(); });

test('Anlegen, mehrere auf einmal, ändern, löschen', async () => {
  const neu = await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: a.id, name: 'Restaurant Seeblick', ort: 'Luzern', stimme: 'Herzlich und gradlinig.', fakten: 'Offen Di bis So ab 11 Uhr.' } });
  assert.equal(neu.status, 201);
  assert.equal(neu.body.ort, 'Luzern');
  const bulk = await srv.call('POST', '/api/einheiten/bulk', { token: adv(), body: { clientId: a.id, zeilen: 'Gasthof Rössli, Zug\nBar Nord;Bern\n\nTrattoria Sole' } });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.body.angelegt, 3);
  const liste = await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() });
  assert.deepEqual(liste.body.map(x => x.name), ['Bar Nord', 'Gasthof Rössli', 'Restaurant Seeblick', 'Trattoria Sole']);
  const put = await srv.call('PUT', `/api/einheiten/${neu.body.id}`, { token: adv(), body: { fakten: 'Offen täglich.' } });
  assert.equal(put.body.fakten, 'Offen täglich.');
  assert.equal(put.body.stimme, 'Herzlich und gradlinig.', 'nicht genannte Felder bleiben');
  assert.equal((await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: a.id, name: '  ' } })).status, 400);
  assert.equal((await srv.call('DELETE', `/api/einheiten/${bulk.body.einheiten[2].id}`, { token: adv() })).status, 200);
  assert.equal((await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() })).body.length, 3);
});

test('Klienten sehen und ändern nur die eigenen Restaurants', async () => {
  const eigenes = (await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() })).body[0];
  assert.equal((await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: H.clientToken(b.id) })).body.length, 0, 'fremde Liste bleibt leer');
  assert.equal((await srv.call('PUT', `/api/einheiten/${eigenes.id}`, { token: H.clientToken(b.id), body: { name: 'X' } })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/einheiten/${eigenes.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/einheiten`, { token: H.clientToken(a.id) })).body.length, 3, 'eigene Liste ohne Angabe der Nummer');
  assert.equal((await srv.call('GET', `/api/einheiten?clientId=${a.id}`)).status, 401);
});

test('Das Stimmprofil und die Fakten des Restaurants fliessen in den Auftrag, nur für das eigene Restaurant', async () => {
  const see = (await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() })).body.find(x => x.name === 'Restaurant Seeblick');
  const fremd = (await srv.call('POST', '/api/einheiten', { token: H.advisorToken(), body: { clientId: b.id, name: 'Fremdes Lokal', stimme: 'GEHEIM FREMD' } })).body;
  H.ai.calls.length = 0;
  const ok = await srv.call('POST', '/api/analyze', { token: H.clientToken(a.id), body: { module: 'text-gen', data: { text: 'Einladung', einheitId: see.id }, instructionsKey: 'text-gen-social' } });
  assert.equal(ok.status, 200);
  const sys = JSON.stringify(H.ai.calls.map(c => c.system));
  assert.ok(sys.includes('BETRIEB: Restaurant Seeblick, Luzern'));
  assert.ok(sys.includes('Herzlich und gradlinig.'));
  assert.ok(sys.includes('Offen täglich.'));
  const verlauf = await srv.call('GET', `/api/analyze/history?clientId=${a.id}&preview=1`, { token: adv() });
  assert.ok(verlauf.body.some(r => r.einheit_id === see.id), 'der Verlauf kennt das Restaurant eines Textes');
  assert.ok(verlauf.body.every(r => r.input_data === undefined), 'Eingaben bleiben im Verlauf verborgen');
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(a.id), body: { module: 'text-gen', data: { text: 'Einladung', einheitId: fremd.id }, instructionsKey: 'text-gen-social' } });
  assert.ok(!JSON.stringify(H.ai.calls.map(c => c.system)).includes('GEHEIM FREMD'), 'Restaurant eines anderen Klienten wird nie geladen');
});

test('Ohne ausdrückliche Freischaltung gibt es keine Restaurants: weder Liste noch Anlegen noch Wirkung im Auftrag', async () => {
  for (const modules of [null, ['brand-voice', 'text-gen']]) {
    await pool.query('UPDATE clients SET enabled_modules=$1 WHERE id=$2', [modules, c.id]);
    assert.deepEqual((await srv.call('GET', `/api/einheiten?clientId=${c.id}`, { token: adv() })).body, []);
    assert.equal((await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: c.id, name: 'X' } })).status, 403);
    assert.equal((await srv.call('POST', '/api/einheiten/bulk', { token: adv(), body: { clientId: c.id, zeilen: 'X' } })).status, 403);
  }
  // Eintrag, der vor dem Abschalten angelegt wurde, bleibt ohne Wirkung
  await pool.query('UPDATE clients SET enabled_modules=$1 WHERE id=$2', [['brand-voice', 'text-gen', 'restaurants'], c.id]);
  const e = (await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: c.id, name: 'Altlast', stimme: 'GEHEIM ALT' } })).body;
  await pool.query('UPDATE clients SET enabled_modules=$1 WHERE id=$2', [['brand-voice', 'text-gen'], c.id]);
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(c.id), body: { module: 'text-gen', data: { text: 'Einladung', einheitId: e.id }, instructionsKey: 'text-gen-social' } });
  assert.ok(!JSON.stringify(H.ai.calls.map(x => x.system)).includes('GEHEIM ALT'));
});

test('Onboarding: «Mehrere Restaurants oder Betriebe» schaltet das Modul frei, andere Wahl nicht', () => {
  const { toEnabledModules, ALLE_MODULE } = require('../lib/moduleCatalog');
  assert.ok(ALLE_MODULE.includes('Mehrere Restaurants oder Betriebe'));
  assert.ok(toEnabledModules(['Text Generator', 'Mehrere Restaurants oder Betriebe']).includes('restaurants'));
  assert.ok(!toEnabledModules(['Text Generator', 'Gespräch']).includes('restaurants'));
});

test('Strukturiertes Faktenblatt: speichern, Auf einen Blick, JSON-LD, Rechte, Auftrag, alte Einträge', async () => {
  const struktur = { strasse: 'Seestrasse 12', plz: '6003', ort: 'Luzern', telefon: '041 123 45 67', kueche: 'Saisonale Küche', oeffnungszeiten: [{ tage: ['Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], von: '11:00', bis: '23:00' }] };
  const neu = await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: a.id, name: 'Faktenhaus Test', fakten: 'Freitext Hinweis.', faktenStruktur: struktur } });
  assert.equal(neu.status, 201);
  assert.equal(neu.body.fakten_struktur.plz, '6003');
  assert.equal(neu.body.fakten_json, undefined);
  const schlecht = await srv.call('PUT', `/api/einheiten/${neu.body.id}`, { token: adv(), body: { faktenStruktur: { plz: '12' } } });
  assert.equal(schlecht.status, 400);
  assert.ok(/PLZ/.test(schlecht.body.error));
  assert.equal((await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: a.id, name: 'Y', faktenStruktur: [] } })).status, 400);
  const put = await srv.call('PUT', `/api/einheiten/${neu.body.id}`, { token: adv(), body: { name: 'Faktenhaus Test' } });
  assert.equal(put.body.fakten_struktur.ort, 'Luzern', 'ohne faktenStruktur bleibt das Blatt');
  const liste = await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() });
  assert.equal(liste.body.find(x => x.id === neu.body.id).fakten_struktur.kueche, 'Saisonale Küche');

  const blick = await srv.call('GET', `/api/einheiten/${neu.body.id}/auf-einen-blick`, { token: adv() });
  assert.equal(blick.status, 200);
  assert.ok(blick.body.some(r => r.label === 'Öffnungszeiten' && r.wert.startsWith('Di bis So 11:00 bis 23:00 Uhr')));
  assert.ok(!/[–—]/.test(JSON.stringify(blick.body)));
  const ld = await srv.call('GET', `/api/einheiten/${neu.body.id}/json-ld`, { token: adv() });
  assert.equal(ld.status, 200);
  assert.equal(ld.body['@type'], 'Restaurant');
  assert.equal(ld.body.address.addressCountry, 'CH');

  // Rechte: fremder Kunde bekommt 403, ohne Anmeldung 401
  for (const p of ['auf-einen-blick', 'json-ld']) {
    assert.equal((await srv.call('GET', `/api/einheiten/${neu.body.id}/${p}`, { token: H.clientToken(b.id) })).status, 403);
    assert.equal((await srv.call('GET', `/api/einheiten/${neu.body.id}/${p}`)).status, 401);
  }
  assert.equal((await srv.call('PUT', `/api/einheiten/${neu.body.id}`, { token: H.clientToken(b.id), body: { faktenStruktur: struktur } })).status, 403);

  // Strukturierte Fakten fliessen vor dem Freitext in den Auftrag
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(a.id), body: { module: 'text-gen', data: { text: 'Einladung', einheitId: neu.body.id }, instructionsKey: 'text-gen-social' } });
  const sys = JSON.stringify(H.ai.calls.map(x => x.system));
  assert.ok(sys.includes('Seestrasse 12, 6003 Luzern'));
  assert.ok(sys.indexOf('Seestrasse 12') < sys.indexOf('Freitext Hinweis.'));

  // Rückwärtskompatibilität: Eintrag ohne fakten_json
  const alt = await pool.query("INSERT INTO einheiten (client_id, name, ort, fakten) VALUES ($1,'Altbetrieb','Zug','Nur Freitext.') RETURNING id", [a.id]);
  const id = alt.rows[0].id;
  assert.deepEqual((await srv.call('GET', `/api/einheiten?clientId=${a.id}`, { token: adv() })).body.find(x => x.id === id).fakten_struktur, {});
  assert.deepEqual((await srv.call('GET', `/api/einheiten/${id}/auf-einen-blick`, { token: adv() })).body, [{ label: 'Adresse', wert: 'Zug' }]);
  assert.equal((await srv.call('GET', `/api/einheiten/${id}/json-ld`, { token: adv() })).body['@type'], 'Restaurant');
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(a.id), body: { module: 'text-gen', data: { text: 'Einladung', einheitId: id }, instructionsKey: 'text-gen-social' } });
  assert.ok(JSON.stringify(H.ai.calls.map(x => x.system)).includes('Nur Freitext.'));
});
