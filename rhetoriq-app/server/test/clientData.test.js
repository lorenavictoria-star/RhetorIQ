// F-10: Klient vollständig löschen und Daten exportieren.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const { pool } = H;

let srv, a, b;
const count = async (t, col = 'client_id', id) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE ${col}=$1`, [id])).rows[0].n;

test.before(async () => {
  await H.setupBase();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`CREATE TABLE people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT)`);
  await pool.query(`CREATE TABLE people_profiles (id SERIAL PRIMARY KEY, person_id INTEGER, content TEXT)`);
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT)`);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, client_id INTEGER, input_tokens BIGINT, output_tokens BIGINT)`);
  await pool.query(`CREATE TABLE email_outbox (id SERIAL PRIMARY KEY, to_email TEXT, body TEXT)`);
  await pool.query(`CREATE TABLE module_examples (id SERIAL PRIMARY KEY, advisor_id INTEGER, source_client_id INTEGER, input_text TEXT)`);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query(`INSERT INTO users (email, name) VALUES ('zwei@test.ch','Zwei')`);
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
  for (const c of [a, b]) {
    await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,1,'text-gen','E-Mail','Geheimer Text ${c.id}')`, [c.id]);
    await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand','x')`, [c.id]);
    const p = (await pool.query(`INSERT INTO people (client_id, name) VALUES ($1,'P') RETURNING id`, [c.id])).rows[0].id;
    await pool.query(`INSERT INTO people_profiles (person_id, content) VALUES ($1,'voice')`, [p]);
    await pool.query(`INSERT INTO usage_log (client_id, input_tokens, output_tokens) VALUES ($1,10,10)`, [c.id]);
    await pool.query(`INSERT INTO client_files (client_id, name, data) VALUES ($1,'u.txt',$2)`, [c.id, Buffer.from('datei')]);
    await pool.query(`INSERT INTO email_outbox (to_email, body) VALUES ('k@test.ch','Mailtext')`);
    await pool.query(`INSERT INTO module_examples (advisor_id, source_client_id, input_text) VALUES (1,$1,'kopie')`, [c.id]);
    await pool.query(`INSERT INTO client_users (client_id, email, name, role) VALUES ($1,'team${c.id}@test.ch','T','editor')`, [c.id]);
  }
  await pool.query(`UPDATE clients SET email='alpha@test.ch' WHERE id=$1`, [a.id]);
  await pool.query(`UPDATE clients SET email='beta@test.ch' WHERE id=$1`, [b.id]);
  await pool.query(`DELETE FROM email_outbox`);
  await pool.query(`INSERT INTO email_outbox (to_email, body) VALUES ('alpha@test.ch','A'),('team${a.id}@test.ch','A2'),('beta@test.ch','B'),('lorena@test.ch','L')`);
  await pool.query(`INSERT INTO schnelltests (email, url, host) VALUES ('alpha@test.ch','x','h'),('beta@test.ch','y','h')`);
  srv = await H.startApp([['/api/clients', require('../routes/clients')]]);
});
test.after(async () => { await srv.close(); });

test('F-10 Export: nur Beraterin, ZIP mit JSON, Dateien und Word, ohne Passwörter', async () => {
  assert.equal((await srv.call('GET', `/api/clients/${a.id}/export-data`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/clients/${a.id}/export-data`, { token: H.advisorToken({ id: 2 }) })).status, 404);
  const r = await srv.call('GET', `/api/clients/${a.id}/export-data`, { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  const names = Object.keys(zip.files);
  assert.ok(names.includes('klient.json') && names.includes('Texte.docx') && names.includes('daten/analyses.json'));
  assert.ok(names.some(n => n.startsWith('dateien/unterlagen/')));
  const kl = await zip.file('klient.json').async('string');
  assert.ok(!/password_hash|"token"/.test(kl));
  const an = await zip.file('daten/analyses.json').async('string');
  assert.ok(an.includes(`Geheimer Text ${a.id}`) && !an.includes(`Geheimer Text ${b.id}`));
});

test('F-10 Löschen: braucht Bestätigung, fremde Beraterin gesperrt', async () => {
  assert.equal((await srv.call('DELETE', `/api/clients/${a.id}`, { token: H.advisorToken() })).status, 400);
  assert.equal((await srv.call('DELETE', `/api/clients/${a.id}?confirm=ja`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/clients/${a.id}?confirm=ja`, { token: H.advisorToken({ id: 2 }) })).status, 404);
  assert.equal(await count('analyses', 'client_id', a.id), 1);
});

test('F-10 Löschen: alle Tabellen leer, andere Klienten unberührt', async () => {
  const r = await srv.call('DELETE', `/api/clients/${a.id}?confirm=ja`, { token: H.advisorToken() });
  assert.equal(r.status, 200);
  for (const t of ['analyses', 'company_memory', 'people', 'client_files', 'client_users']) assert.equal(await count(t, 'client_id', a.id), 0, t);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM people_profiles')).rows[0].n, 1, 'nur das Profil des anderen Klienten bleibt');
  assert.equal(await count('module_examples', 'source_client_id', a.id), 0);
  assert.equal(await count('usage_log', 'client_id', a.id), 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM usage_log WHERE client_id IS NULL')).rows[0].n, 1, 'Kostenzeile bleibt anonym');
  const mails = (await pool.query('SELECT to_email FROM email_outbox ORDER BY id')).rows.map(x => x.to_email);
  assert.deepEqual(mails, ['beta@test.ch', 'lorena@test.ch'], 'Mails an Klient und Team gelöscht');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM schnelltests')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM clients WHERE id=$1', [a.id])).rows[0].n, 0);
  for (const t of ['analyses', 'company_memory', 'people', 'client_files', 'client_users']) assert.equal(await count(t, 'client_id', b.id), 1, 'Beta ' + t);
  assert.equal((await srv.call('DELETE', `/api/clients/${a.id}?confirm=ja`, { token: H.advisorToken() })).status, 404);
});
