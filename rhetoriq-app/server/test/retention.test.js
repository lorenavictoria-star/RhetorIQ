// F-17 / F-10: Löschfristen der E-Mail-Warteschlange und des Fehlerprotokolls.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;

test('Löschfristen: gesendete Mails nach 7 Tagen geleert, nach 90 Tagen gelöscht, Fehlerprotokoll nach 90 Tagen', async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE email_outbox (id SERIAL PRIMARY KEY, kind TEXT, to_email TEXT, subject TEXT, body TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), sent_at TIMESTAMPTZ, attachments JSONB)`);
  await pool.query(`CREATE TABLE generation_errors (id SERIAL PRIMARY KEY, error_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const day = (n) => new Date(Date.now() - n * 86400000);
  const ins = async (status, ageDays, sentAgeDays) => (await pool.query(
    `INSERT INTO email_outbox (kind, to_email, subject, body, status, created_at, sent_at, attachments) VALUES ('x','a@b.ch','S','Geheimer Text',$1,$2,$3,$4) RETURNING id`,
    [status, day(ageDays), sentAgeDays == null ? null : day(sentAgeDays), JSON.stringify([{ name: 'a.xlsx' }])])).rows[0].id;
  const fresh = await ins('sent', 1, 1);
  const old = await ins('sent', 10, 10);
  const pending = await ins('pending', 10, null);
  const ancient = await ins('sent', 100, 100);
  await pool.query(`INSERT INTO generation_errors (error_message, created_at) VALUES ('alt',$1),('neu',$2)`, [day(100), day(1)]);
  const { runRetention } = require('../lib/retention');
  const r = await runRetention();
  const get = async (id) => (await pool.query('SELECT body, attachments FROM email_outbox WHERE id=$1', [id])).rows[0];
  assert.equal((await get(fresh)).body, 'Geheimer Text', 'frische gesendete Mail unverändert');
  assert.equal((await get(old)).body, '', 'gesendet vor 10 Tagen: Inhalt geleert');
  assert.equal((await get(old)).attachments, null);
  assert.equal((await get(pending)).body, 'Geheimer Text', 'noch nicht gesendet: bleibt für den Versand');
  assert.equal(await get(ancient), undefined, 'nach 90 Tagen gelöscht');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM generation_errors')).rows[0].n, 1);
  assert.equal(r.deletedErrors, 1);
});
