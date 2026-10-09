// F-09: Anfrageformular: Sammelmeldung, bereinigte Namen, Warnung bei Flut.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;
const { safeName, ackText } = require('../lib/inquiryMails');

let srv;
test.before(async () => {
  await H.setupBase();
  const inq = require('../routes/inquiries');
  srv = await H.startApp([['/api/inquiry', inq.publicRouter]]);
});
test.after(async () => { await srv.close(); });

async function send(i, extra = {}) {
  const r = await fetch(srv.base + '/api/inquiry', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://rhetoriq.ch' },
    body: JSON.stringify({ name: 'Person ' + i, email: `p${i}@firma.ch`, message: 'Hallo ' + i, elapsed: 5000, ...extra })
  });
  return r.status;
}
const kinds = (k) => H.mails.filter(m => m.kind === k);
const wait = () => new Promise(r => setTimeout(r, 30));

test('F-09 Bereinigung: keine Zeilenumbrüche, keine Links, keine Adressen im Namen', () => {
  const t = ackText({ name: 'Max\r\nBetreff: Gewinn http://boese.ch/x www.boese.com bob@boese.ch Muster' });
  const first = t.split('\n')[0];
  assert.ok(!/http|www|boese|@/.test(first), first);
  assert.ok(t.split('\n')[1] === '', 'Name erzeugt keine zusätzlichen Zeilen');
  assert.equal(safeName('Anna Müller'), 'Anna Müller');
  assert.equal(ackText({ name: 'http://x.ch' }).split('\n')[0], 'Guten Tag');
});

test('F-09 Normalfall: einzelne Anfragen lösen je eine Hinweismail und eine Bestätigung aus', async () => {
  assert.equal(await send(1), 200);
  await wait();
  assert.equal(kinds('inquiry_notify').length, 1);
  assert.equal(kinds('inquiry_ack').length, 1);
});

test('F-09 Mehr als 5 Anfragen in 15 Minuten: eine Sammelmeldung statt einer Mail je Anfrage', async () => {
  for (let i = 2; i <= 9; i++) assert.equal(await send(i), 200);
  await wait();
  assert.equal(kinds('inquiry_notify').length, 5, 'höchstens 5 Einzelmails');
  assert.equal(kinds('inquiry_digest').length, 1, 'genau eine Sammelmeldung');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM inquiries');
  assert.equal(rows[0].n, 9, 'alle Anfragen bleiben gespeichert');
});

test('F-09 Flood-Grenze: Warnung an Lorena statt stillem Verwerfen', async () => {
  for (let i = 100; i < 160; i++) await pool.query(`INSERT INTO inquiries (name, email, message) VALUES ('x', $1, 'm')`, [`f${i}@x.ch`]);
  assert.equal(await send(500), 200);
  await wait();
  assert.equal(kinds('inquiry_flood').length, 1);
  assert.equal(await send(501), 200);
  await wait();
  assert.equal(kinds('inquiry_flood').length, 1, 'nur eine Warnung je Stunde');
});
