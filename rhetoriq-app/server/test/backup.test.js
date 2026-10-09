// Gesamtexport und Papierkorb (Soft-Delete mit 30 Tagen Frist).
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const { pool } = H;

let srv, a, b, c;
const count = async (t, col, id) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE ${col}=$1`, [id])).rows[0].n;

test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT)`);
  await pool.query(`CREATE TABLE people_profiles (id SERIAL PRIMARY KEY, person_id INTEGER, content TEXT)`);
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT)`);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, client_id INTEGER, input_tokens BIGINT, output_tokens BIGINT)`);
  await pool.query(`CREATE TABLE module_examples (id SERIAL PRIMARY KEY, advisor_id INTEGER, source_client_id INTEGER, input_text TEXT)`);
  await require('../lib/schemaRedesign').ensureSchema();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`CREATE TABLE email_outbox (id SERIAL PRIMARY KEY, to_email TEXT, body TEXT)`);
  for (const col of ['capital_markets_enabled BOOLEAN', 'hotel_enabled BOOLEAN', 'address TEXT']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`UPDATE users SET password_hash='GEHEIMER-HASH' WHERE id=1`);
  await pool.query(`INSERT INTO users (email, name) VALUES ('zwei@test.ch','Zwei')`);
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
  c = await H.addClient('Fremd AG');
  await pool.query(`UPDATE clients SET advisor_id=2, password_hash='CLIENT-HASH' WHERE id=$1`, [c.id]);
  await pool.query(`UPDATE clients SET password_hash='CLIENT-HASH' WHERE id=$1`, [a.id]);
  // mehr als eine Seite (500) Texte für Alpha
  for (let i = 0; i < 620; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,1,'text-gen','E-Mail',$2)`, [a.id, `Text ${i}`]);
  await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,2,'text-gen','E-Mail','FREMDER TEXT')`, [c.id]);
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice','Stimme Alpha'),($2,'brand_voice','GEHEIM FREMD')`, [a.id, c.id]);
  const p = (await pool.query(`INSERT INTO people (client_id, name) VALUES ($1,'Hans') RETURNING id`, [a.id])).rows[0].id;
  await pool.query(`INSERT INTO people_profiles (person_id, content) VALUES ($1,'voice dna')`, [p]);
  await pool.query(`INSERT INTO client_files (client_id, name, data) VALUES ($1,'u.txt',$2)`, [a.id, Buffer.from('INHALT-DER-DATEI')]);
  srv = await H.startApp([['/api/backup', require('../routes/backup')], ['/api/papierkorb', require('../routes/papierkorb')], ['/api/clients', require('../routes/clients')]]);
});
test.after(async () => { await srv.close(); });

test('Gesamtexport: JSON je Tabelle, seitenweise, ohne Hashes und fremde Daten', async () => {
  assert.equal((await srv.call('GET', '/api/backup/export.zip')).status, 401);
  assert.equal((await srv.call('GET', '/api/backup/export.zip', { token: H.clientToken(a.id) })).status, 403);
  const r = await srv.call('GET', '/api/backup/export.zip', { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  const names = Object.keys(zip.files);
  for (const n of ['daten/clients.json', 'daten/analyses.json', 'daten/company_memory.json', 'daten/people_profiles.json', 'daten/users.json', 'LIESMICH.txt']) assert.ok(names.includes(n), n);
  const analyses = JSON.parse(await zip.file('daten/analyses.json').async('string'));
  assert.equal(analyses.length, 620, 'alle Seiten gelesen');
  const all = (await Promise.all(names.filter(n => !zip.files[n].dir).map(n => zip.file(n).async('string')))).join('\n');
  assert.ok(!all.includes('GEHEIMER-HASH') && !all.includes('CLIENT-HASH'), 'keine Hashes');
  assert.ok(!all.includes('password_hash'), 'keine Hash-Spalte');
  assert.ok(!all.includes('FREMDER TEXT') && !all.includes('GEHEIM FREMD') && !all.includes('Fremd AG'), 'nur eigene Klienten');
  assert.ok(!all.includes('INHALT-DER-DATEI'), 'Dateien nur als Liste');
  assert.ok(all.includes('Stimme Alpha'));
  const clients = JSON.parse(await zip.file('daten/clients.json').async('string'));
  assert.equal(clients.length, 2);
  assert.ok(clients.every(x => !('token' in x) && !('password_hash' in x) && !('token_version' in x)));
});

test('Papierkorb: Löschen blendet aus, Anmeldung und Zugriff gesperrt, Wiederherstellen holt zurück', async () => {
  const list0 = await srv.call('GET', '/api/clients', { token: H.advisorToken() });
  assert.ok(list0.body.some(x => x.id === b.id));
  assert.equal((await srv.call('DELETE', `/api/clients/${b.id}`, { token: H.advisorToken() })).status, 400);
  const d = await srv.call('DELETE', `/api/clients/${b.id}?confirm=ja`, { token: H.advisorToken() });
  assert.equal(d.status, 200);
  assert.equal(d.body.papierkorb, true);
  assert.ok((await pool.query('SELECT geloescht_am FROM clients WHERE id=$1', [b.id])).rows[0].geloescht_am);
  assert.equal(await count('clients', 'id', b.id), 1, 'Daten bleiben erhalten');
  const list1 = await srv.call('GET', '/api/clients', { token: H.advisorToken() });
  assert.ok(!list1.body.some(x => x.id === b.id), 'aus der Liste ausgeblendet');
  const { canAccessClient } = require('../middleware/ownership');
  assert.equal(await canAccessClient({ user: { role: 'advisor', id: 1 } }, b.id), false);
  assert.equal(await canAccessClient({ user: { role: 'advisor', id: 1 } }, a.id), true);
  const pk = await srv.call('GET', '/api/papierkorb', { token: H.advisorToken() });
  assert.deepEqual(pk.body.map(x => x.id), [b.id]);
  assert.ok(pk.body[0].tageBleiben >= 29 && pk.body[0].tageBleiben <= 30);
  assert.equal((await srv.call('GET', '/api/papierkorb', { token: H.clientToken(a.id) })).status, 403);
  const exp = await srv.call('GET', '/api/backup/export.zip', { token: H.advisorToken(), raw: true });
  const zip = await JSZip.loadAsync(Buffer.from(await exp.arrayBuffer()));
  assert.equal(JSON.parse(await zip.file('daten/clients.json').async('string')).length, 2, 'Export enthält auch den Papierkorb');
  // Wiederherstellen
  assert.equal((await srv.call('POST', `/api/papierkorb/${a.id}/wiederherstellen`, { token: H.advisorToken() })).status, 404);
  assert.equal((await srv.call('POST', `/api/papierkorb/${b.id}/wiederherstellen`, { token: H.advisorToken() })).status, 200);
  assert.equal((await pool.query('SELECT geloescht_am FROM clients WHERE id=$1', [b.id])).rows[0].geloescht_am, null);
  assert.ok((await srv.call('GET', '/api/clients', { token: H.advisorToken() })).body.some(x => x.id === b.id));
});

test('Papierkorb: Sitzung des Klienten wird abgemeldet', async () => {
  const before = (await pool.query('SELECT token_version FROM clients WHERE id=$1', [b.id])).rows[0].token_version;
  await srv.call('DELETE', `/api/clients/${b.id}?confirm=ja`, { token: H.advisorToken() });
  const after = (await pool.query('SELECT token_version FROM clients WHERE id=$1', [b.id])).rows[0].token_version;
  assert.equal(after, before + 1);
  const { requireAuth } = require('../middleware/auth');
  let status = null;
  await requireAuth({ headers: { authorization: 'Bearer ' + H.clientToken(b.id, { tokenVersion: after }) }, body: {}, query: {}, params: {} },
    { status(s) { status = s; return { json() {} }; } }, () => { status = 'weiter'; });
  assert.equal(status, 401, 'Token eines Klienten im Papierkorb gilt nicht mehr');
  await srv.call('POST', `/api/papierkorb/${b.id}/wiederherstellen`, { token: H.advisorToken() });
});

test('Job: erst nach 30 Tagen endgültig, vorher nicht', async () => {
  const pk = require('../lib/papierkorb');
  await srv.call('DELETE', `/api/clients/${b.id}?confirm=ja`, { token: H.advisorToken() });
  assert.equal(await pk.endgueltigNachFrist(new Date()), 0);
  assert.equal(await pk.endgueltigNachFrist(new Date(Date.now() + 29 * 86400000)), 0);
  assert.equal(await count('clients', 'id', b.id), 1);
  await pool.query('SELECT 1');
  const n = await pk.endgueltigNachFrist(new Date(Date.now() + 31 * 86400000));
  assert.equal(n >= 1, true);
  assert.equal(await count('clients', 'id', b.id), 0, 'endgültig gelöscht');
  assert.equal(await count('clients', 'id', a.id), 1, 'andere Klienten unberührt');
  assert.equal(await count('analyses', 'client_id', a.id), 620);
});

test('Sofort endgültig: aus dem Papierkorb oder mit endgueltig=ja', async () => {
  const x = await H.addClient('Sofort AG');
  assert.equal((await srv.call('DELETE', `/api/papierkorb/${x.id}?confirm=ja`, { token: H.advisorToken() })).status, 404, 'nur aus dem Papierkorb');
  await srv.call('DELETE', `/api/clients/${x.id}?confirm=ja`, { token: H.advisorToken() });
  assert.equal((await srv.call('DELETE', `/api/papierkorb/${x.id}`, { token: H.advisorToken() })).status, 400);
  assert.equal((await srv.call('DELETE', `/api/papierkorb/${x.id}?confirm=ja`, { token: H.advisorToken() })).status, 200);
  assert.equal(await count('clients', 'id', x.id), 0);
  const y = await H.addClient('Direkt AG');
  assert.equal((await srv.call('DELETE', `/api/clients/${y.id}?confirm=ja&endgueltig=ja`, { token: H.advisorToken() })).status, 200);
  assert.equal(await count('clients', 'id', y.id), 0);
});
