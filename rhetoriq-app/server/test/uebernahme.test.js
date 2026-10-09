// Übernahmequote: Anteil unverändert gesendeter KI-Texte, ohne KI-Aufruf.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const ue = require('../lib/uebernahme');

let srv, a, b;
const T1 = 'Guten Tag. Wir danken Ihnen für Ihre Anfrage. Gerne senden wir Ihnen ein Angebot.';
const NOW = new Date('2026-10-14T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();
const add = (clientId, orig, edited, when, status = 'approved') =>
  pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status, updated_at) VALUES ($1,'E-Mail',$2,$3,$4,$5)`, [clientId, orig, edited, status, when]);

test.before(async () => {
  await H.setupBase();
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  srv = await H.startApp([['/api/comm-profile', require('../routes/commProfile')]]);
});
test.after(async () => { await srv.close(); });

test('compute: unverändert unter 10 Prozent, Durchschnitt des veränderten Anteils', () => {
  const r = ue.compute([
    { original_text: T1, edited_text: T1 },
    { original_text: T1, edited_text: 'Anderer Text. Wir danken Ihnen für Ihre Anfrage. Gerne senden wir Ihnen ein Angebot.' },
    { original_text: T1, edited_text: 'Ganz neu. Völlig anders. Nichts bleibt.' },
    { original_text: T1, edited_text: null }
  ]);
  assert.equal(r.count, 3);
  assert.equal(r.unchanged, 1);
  assert.equal(r.ratePct, 33);
  assert.equal(r.avgChangedPct, Math.round((0 + 1 / 3 + 1) / 3 * 100));
  assert.equal(ue.compute([]).ratePct, null);
});

test('Woche: aktuelle Woche gegen Vorwoche, nur gesendete Freigaben', async () => {
  await add(a.id, T1, T1, ago(1));
  await add(a.id, T1, T1, ago(2));
  await add(a.id, T1, 'Neu. Anders. Alles.', ago(3));
  await add(a.id, T1, T1, ago(2), 'edited');
  await add(a.id, T1, 'Neu. Anders. Alles.', ago(9));
  await add(a.id, T1, 'Neu. Anders. Alles.', ago(10));
  await add(b.id, T1, T1, ago(1));
  const r = await ue.forClient(a.id, 'week', NOW);
  assert.equal(r.current.count, 3);
  assert.equal(r.current.ratePct, 67);
  assert.equal(r.previous.count, 2);
  assert.equal(r.previous.ratePct, 0);
  assert.equal(r.deltaPts, 67);
});

test('Monat und alle Klienten für die Berichte', async () => {
  const m = await ue.forClient(a.id, 'month', NOW);
  assert.equal(m.current.count, 5, 'Oktober 2026 bis zum 14.: fünf gesendete Freigaben');
  const all = await ue.forAllClients('week', NOW);
  assert.deepEqual(all.map(x => x.name), ['Alpha AG', 'Beta AG']);
  const lines = ue.reportLines(all, 'Vorwoche');
  assert.ok(lines[0].includes('Alpha AG') && lines[0].includes('+67 Punkte gegenüber der Vorwoche'));
  assert.ok(lines[1].includes('kein Vergleich'));
  assert.ok(ue.reportLines([])[0].includes('Keine'));
});

test('Endpunkt: Klient sieht nur seine Zahlen, fremder Klient wird abgewiesen', async () => {
  const ok = await srv.call('GET', `/api/comm-profile/${b.id}/uebernahme?period=month`, { token: H.clientToken(b.id) });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.current);
  const no = await srv.call('GET', `/api/comm-profile/${a.id}/uebernahme`, { token: H.clientToken(b.id) });
  assert.ok([403, 404].includes(no.status));
  const adv = await srv.call('GET', `/api/comm-profile/${a.id}/uebernahme`, { token: H.advisorToken() });
  assert.equal(adv.status, 200);
});
