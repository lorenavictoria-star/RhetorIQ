const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, c, other, cuId;
test.before(async () => {
  await H.setupBase();
  c = await H.addClient('Archiv AG');
  other = await H.addClient('Fremd AG');
  cuId = (await pool.query('INSERT INTO client_users (client_id) VALUES ($1) RETURNING id', [c.id])).rows[0].id;
  await pool.query('ALTER TABLE client_users ADD COLUMN role TEXT').catch(() => {});
  const ins = (cid, key, label, text, date) => pool.query(
    `INSERT INTO analyses (client_id, advisor_id, module, module_label, result, feedback_key, created_at) VALUES ($1,1,'text-gen',$2,$3,$4,$5)`,
    [cid, label, text, key, date]);
  await ins(c.id, 'text-gen-speech', 'Text Generator', '# Rede zum Jubiläum\nLiebe Gäste, wir feiern heute. Wir feiern gemeinsam. Wir feiern gemeinsam heute.', '2026-03-05T10:00:00Z');
  await ins(c.id, 'text-gen-speech', 'Text Generator', 'Zweite Rede\nKurz.', '2026-06-01T10:00:00Z');
  await ins(c.id, 'text-gen-speech', 'Text Generator', 'Alte Rede 2025', '2025-02-01T10:00:00Z');
  await ins(c.id, 'text-gen-email', 'Text Generator', 'Eine E-Mail', '2026-04-01T10:00:00Z');
  await ins(other.id, 'text-gen-speech', 'Text Generator', 'Fremde Rede', '2026-04-01T10:00:00Z');
  srv = await H.startApp([['/api/archive', require('../routes/archive')]]);
});
test.after(async () => { await srv.close(); });

test('Liste: nur Reden des Jahres, absteigend, mit Titel und Länge', async () => {
  const r = await srv.call('GET', `/api/archive/${c.id}/reden?year=2026`, { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.equal(r.body.reden.length, 2);
  assert.equal(r.body.reden[0].title, 'Zweite Rede');
  assert.equal(r.body.reden[1].title, 'Rede zum Jubiläum');
  assert.ok(r.body.reden[1].words > 10);
  assert.ok(r.body.years.includes(2025));
});

test('Zugriff: Klient nur eigene Daten, Team ohne Admin gesperrt', async () => {
  assert.equal((await srv.call('GET', `/api/archive/${c.id}/reden?year=2026`, { token: H.clientToken(c.id) })).status, 200);
  assert.equal((await srv.call('GET', `/api/archive/${other.id}/reden?year=2026`, { token: H.clientToken(c.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/archive/${c.id}/reden`, { token: H.clientToken(c.id, { clientUserId: cuId, clientUserRole: 'editor' }) })).status, 403);
  assert.equal((await srv.call('GET', `/api/archive/${c.id}/rueckblick.docx`, { token: H.clientToken(c.id, { clientUserId: cuId, clientUserRole: 'editor' }) })).status, 403);
});

test('Word-Rückblick wird erzeugt', async () => {
  const r = await srv.call('GET', `/api/archive/${c.id}/rueckblick.docx?year=2026`, { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(/Reden-Archiv_Archiv_AG_2026/.test(r.headers.get('content-disposition')));
});
