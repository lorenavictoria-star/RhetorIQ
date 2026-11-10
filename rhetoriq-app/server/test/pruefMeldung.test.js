const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const pm = require('../lib/pruefMeldung');

let srv, c;
const at = iso => new Date(iso);
test.before(async () => {
  await H.setupBase();
  c = await H.addClient('Beispiel AG');
  srv = await H.startApp([['/api/reviews', require('../routes/reviews')]]);
});
test.after(async () => { await srv.close(); });

test('Meldefenster: 90 Minuten ab 07:00 Zürcher Zeit, keines in der Nacht', () => {
  // 7. Mai 2027 (Sommerzeit, UTC+2)
  assert.equal(pm.slotKey(at('2027-05-07T04:59:00Z')), null);              // 06:59
  assert.equal(pm.slotKey(at('2027-05-07T05:00:00Z')), '2027-05-07-0');    // 07:00
  assert.equal(pm.slotKey(at('2027-05-07T06:29:00Z')), '2027-05-07-0');    // 08:29
  assert.equal(pm.slotKey(at('2027-05-07T06:30:00Z')), '2027-05-07-1');    // 08:30
  assert.equal(pm.slotKey(at('2027-05-07T17:59:00Z')), '2027-05-07-8');    // 19:59
  assert.equal(pm.slotKey(at('2027-05-07T18:00:00Z')), null);              // 20:00
  // Winterzeit (UTC+1)
  assert.equal(pm.slotKey(at('2027-01-12T06:00:00Z')), '2027-01-12-0');    // 07:00
});

test('Sofort nur bei Fristen von höchstens einer Stunde', () => {
  const jetzt = at('2027-05-07T08:00:00Z');
  assert.equal(pm.sofortNoetig(new Date(jetzt.getTime() + 30 * 60000), jetzt), true);
  assert.equal(pm.sofortNoetig(new Date(jetzt.getTime() + 60 * 60000), jetzt), true);
  assert.equal(pm.sofortNoetig(new Date(jetzt.getTime() + 61 * 60000), jetzt), false);
  assert.equal(pm.sofortNoetig(null, jetzt), false);
});

test('Eingang: Frist unter einer Stunde meldet sofort, sonst keine Mail und der Text steht trotzdem in der Liste', async () => {
  H.mails.length = 0;
  await pool.query('DELETE FROM review_requests');
  const post = body => srv.call('POST', '/api/reviews', { token: H.clientToken(c.id), body: { clientId: c.id, moduleLabel: 'LinkedIn', originalText: 'Text', ...body } });
  const spaet = await post({ note: 'Normal' });                                                   // Frist in 3 Stunden
  assert.equal(spaet.status, 200);
  const eilig = await post({ note: 'Eilig', dueAt: new Date(Date.now() + 30 * 60000).toISOString() });
  assert.equal(eilig.status, 200);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(H.mails.filter(m => m.kind === 'review-request').length, 1);
  assert.ok(H.mails.find(m => m.kind === 'review-request').text.includes('Eilig'));
  const liste = await srv.call('GET', '/api/reviews', { token: H.advisorToken() });
  assert.equal(liste.body.length, 2);
  const { rows } = await pool.query('SELECT note, notified_at FROM (SELECT client_note AS note, notified_at FROM review_requests) x ORDER BY note');
  assert.equal(rows.find(r => r.note === 'Eilig').notified_at !== null, true);
  assert.equal(rows.find(r => r.note === 'Normal').notified_at, null);
});

test('Sammelmail: nur im Meldefenster, einmal je Fenster, nur bei Neuem, markiert die Texte', async () => {
  H.mails.length = 0;
  await pool.query('DELETE FROM review_requests');
  await pool.query('DELETE FROM job_laeufe').catch(() => {});
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, client_note, status, due_at) VALUES ($1,'Newsletter','a','Bitte kurz','pending',$2), ($1,'Webseite','b',NULL,'pending',NULL)`, [c.id, new Date('2027-05-07T11:00:00Z')]);
  assert.equal(await pm.sammelmeldung(at('2027-05-07T04:00:00Z')), 0);   // 06:00, nachts: keine Mail
  assert.equal(await pm.sammelmeldung(at('2027-05-07T06:35:00Z')), 2);   // 08:35
  const mails = H.mails.filter(m => m.kind === 'review-sammel');
  assert.equal(mails.length, 1);
  assert.ok(mails[0].subject.includes('2 Texte'));
  assert.ok(mails[0].text.includes('Newsletter') && mails[0].text.includes('Beispiel AG') && mails[0].text.includes('Bitte kurz'));
  assert.equal(await pm.sammelmeldung(at('2027-05-07T06:50:00Z')), 0);   // gleiches Fenster, nichts Neues
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, status) VALUES ($1,'Rede','c','pending')`, [c.id]);
  assert.equal(await pm.sammelmeldung(at('2027-05-07T07:00:00Z')), 0);   // 09:00, gleiches Fenster (07:00 bis 08:30 vorbei? Fenster 1 endet 10:00)
  assert.equal(await pm.sammelmeldung(at('2027-05-07T08:30:00Z')), 1);   // 10:30, neues Fenster, nur der neue Text
  assert.equal(H.mails.filter(m => m.kind === 'review-sammel').length, 2);
});

test('Erinnerung: kurz vor Ablauf der Frist, einmal je Text', async () => {
  H.mails.length = 0;
  await pool.query('DELETE FROM review_requests');
  const jetzt = at('2027-05-08T08:00:00Z');   // 10:00
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, status, due_at) VALUES ($1,'Social Media','a','pending',$2), ($1,'Presse','b','pending',$3)`, [c.id, new Date(jetzt.getTime() + 20 * 60000), new Date(jetzt.getTime() + 5 * 3600000)]);
  assert.equal(await pm.erinnerungen(jetzt), 1);
  assert.equal(await pm.erinnerungen(jetzt), 0);
  assert.ok(H.mails[0].text.includes('Social Media') && !H.mails[0].text.includes('Presse'));
  assert.equal(await pm.erinnerungen(at('2027-05-08T04:00:00Z')), 0);   // nachts keine Erinnerung
});
