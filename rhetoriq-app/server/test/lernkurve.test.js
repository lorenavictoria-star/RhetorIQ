// Lernkurve: Satzanteil, Monatskurve, Klientensatz und Zugriff.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const lk = require('../lib/lernkurve');

let srv, a, b;
const S = ['Wir freuen uns auf die Zusammenarbeit im neuen Jahr.', 'Die Unterlagen schicken wir Ihnen bis Freitag zu.', 'Bei Fragen melden Sie sich jederzeit bei uns.', 'Unser Team steht Ihnen gerne zur Verfügung.'];
const AI = S.join(' ');

async function freigabe(clientId, datum, geaendert) {
  const edited = S.map((s, i) => (i < geaendert ? s.replace('Wir', 'Gerne').replace('Die', 'Alle').replace('Bei', 'Falls').replace('Unser', 'Mein') + ' Zusatz drei Wörter.' : s)).join(' ');
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status, created_at, updated_at) VALUES ($1,'E-Mail',$2,$3,'approved',$4,$4)`, [clientId, AI, edited, datum]);
}

test.before(async () => {
  await H.setupBase();
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  await pool.query('INSERT INTO client_users (id, client_id) VALUES (7, $1)', [a.id]);
  srv = await H.startApp([['/api/lernkurve', require('../routes/lernkurve')]]);
});
test.after(async () => { await srv.close(); });

test('Satzanteil: unverändert, teilweise, Normalisierung', () => {
  assert.equal(lk.anteilUnveraenderterSaetze(AI, AI), 1);
  assert.equal(lk.anteilUnveraenderterSaetze(AI, S[0] + ' Etwas ganz anderes steht hier jetzt.'), 0.25);
  assert.equal(lk.anteilUnveraenderterSaetze(AI.toUpperCase(), AI.replace(/\./g, '!')), 1);
  assert.equal(lk.anteilUnveraenderterSaetze('', AI), null);
});

test('Kurve und Satz: zwei Monate mit je drei Freigaben', async () => {
  const now = new Date(), m = (back) => new Date(now.getFullYear(), now.getMonth() - back, 10, 12);
  for (let i = 0; i < 3; i++) { await freigabe(a.id, m(3), 2); await freigabe(a.id, m(0), 1); }
  const k = await lk.monatlicheKurve(a.id, 6);
  assert.equal(k.length, 6);
  assert.equal(k[5].freigaben, 3);
  assert.equal(k[5].prozent, 75);
  assert.equal(k[2].prozent, 50);
  const d = await lk.lernkurve(a.id);
  assert.match(d.satz, new RegExp(`^Im ${lk.MONATE[m(0).getMonth()]} übernahm Lorena 75 Prozent Ihrer Sätze unverändert, im ${lk.MONATE[m(3).getMonth()]} waren es 50 Prozent\\.$`));
});

test('kein Satz bei nur einem tragfähigen Monat', async () => {
  const now = new Date();
  for (let i = 0; i < 3; i++) await freigabe(b.id, new Date(now.getFullYear(), now.getMonth(), 5, 12), 1);
  await freigabe(b.id, new Date(now.getFullYear(), now.getMonth() - 2, 5, 12), 2);
  const d = await lk.lernkurve(b.id);
  assert.equal(d.satz, null);
});

test('Endpunkt: Beraterin, eigener Klient, fremder Klient, Teamrolle', async () => {
  const r = await srv.call('GET', `/api/lernkurve/${a.id}`, { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.ok(r.body.satz && r.body.satzBeraterin && r.body.kurve.length === 6);
  const own = await srv.call('GET', `/api/lernkurve/${a.id}`, { token: H.clientToken(a.id) });
  assert.equal(own.status, 200);
  assert.ok(own.body.satz);
  assert.equal(own.body.satzBeraterin, undefined);
  assert.equal((await srv.call('GET', `/api/lernkurve/${a.id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/lernkurve/${a.id}`, { token: H.clientToken(a.id, { clientUserId: 7, clientUserRole: 'member' }) })).status, 403);
});
