const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const tp = require('../lib/themenplan');
const { runThemenplanJob } = require('../jobs/themenplan');
const aiProvider = require('../lib/aiProvider');

let srv, a, b, c;
const NOW = new Date('2026-11-01T06:00:00+01:00');
const PLAN = JSON.stringify({ themen: Array.from({ length: 9 }, (_, i) => ({ titel: `Thema ${i + 1} – mit Strich`, anlass: 'Herbst', kernaussage: 'Ein Satz.', textart: 'Newsletter', termin: '10.11.2026' })) });

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN included_minutes INTEGER').catch(() => {});
  a = await H.addClient('Aktiv AG'); b = await H.addClient('Inaktiv AG'); c = await H.addClient('Fremd AG');
  srv = await H.startApp([['/api/themenplan', require('../routes/themenplan')], ['/api/onboarding-drafts', require('../routes/onboardingDrafts')]]);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [a.id]);
  H.ai.reply = (o) => (/Newsletter-Entwurf/.test(o.messages[0].content) ? 'BETREFF: Herbst\nVORSCHAU: kurz\nText – mit Strich.' : PLAN);
});
test.after(async () => { await srv.close(); });

test('Kalender: Ostern und Feiertage, Jahreszeit', () => {
  assert.equal(tp.easter(2026).toISOString().slice(0, 10), '2026-04-05');
  assert.deepEqual(tp.feiertage(2026, 12).map(x => x.name), ['Heiligabend', 'Weihnachten', 'Stephanstag', 'Silvester']);
  assert.ok(tp.feiertage(2026, 5).some(x => x.name === 'Auffahrt' && x.tag === 14));
  assert.equal(tp.jahreszeit(11), 'Herbst');
});

test('Job: nur aktive Klienten, Freigaben entstehen, ein Lauf pro Monat', async () => {
  const n0 = H.ai.calls.length;
  const out = await runThemenplanJob({ now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].clientId, a.id);
  assert.equal(out[0].status, 'fertig');
  assert.equal(H.ai.calls.length - n0, 2, 'Themenplan und Newsletter');
  assert.ok(H.ai.calls[n0].meter && H.ai.calls[n0].meter.module === 'themenplan' && H.ai.calls[n0].meter.clientId === a.id);
  const { rows } = await pool.query(`SELECT module_label, status, instruction, original_text, client_id FROM review_requests WHERE client_id=$1 ORDER BY id`, [a.id]);
  assert.deepEqual(rows.map(r => r.module_label), ['Themenplan', 'Newsletter-Entwurf']);
  assert.ok(rows.every(r => r.status === 'pending'));
  assert.equal(rows[0].instruction, 'Monatlicher Themenplan, Durchsicht ca. 30 Minuten');
  assert.ok(rows[0].original_text.startsWith('THEMENPLAN NOVEMBER 2026'));
  assert.ok(!/[–—]/.test(rows[0].original_text + rows[1].original_text), 'keine Gedankenstriche');
  assert.equal((await pool.query('SELECT 1 FROM review_requests WHERE client_id=$1', [b.id])).rows.length, 0);
  // zweiter Lauf im selben Monat: nichts passiert
  const again = await runThemenplanJob({ now: NOW });
  assert.equal(again[0].status, 'uebersprungen');
  assert.equal(H.ai.calls.length - n0, 2);
  assert.equal((await pool.query('SELECT 1 FROM review_requests WHERE client_id=$1', [a.id])).rows.length, 2);
  // nächster Monat läuft wieder
  const next = await runThemenplanJob({ now: new Date('2026-12-01T06:00:00+01:00') });
  assert.equal(next[0].status, 'fertig');
});

test('Abschaltbar mit THEMENPLAN=aus', async () => {
  process.env.THEMENPLAN = 'aus';
  try { assert.deepEqual(await runThemenplanJob({ now: new Date('2027-01-01T06:00:00+01:00') }), []); } finally { delete process.env.THEMENPLAN; }
});

test('Kostenobergrenze: Abbruch ohne Freigabe, Wiederholung danach möglich', async () => {
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [b.id]);
  const orig = aiProvider.generateText;
  aiProvider.generateText = async () => ({ text: PLAN, inputTokens: 100000, outputTokens: 20000, model: 'claude-sonnet-4-6' });   // rund 0.60 US-Dollar
  try {
    const r = await tp.runForClient(b.id, { now: NOW });
    assert.equal(r.status, 'abgebrochen');
    assert.equal((await pool.query('SELECT 1 FROM review_requests WHERE client_id=$1', [b.id])).rows.length, 0);
    assert.equal((await pool.query('SELECT status FROM themenplan_laeufe WHERE client_id=$1', [b.id])).rows[0].status, 'abgebrochen');
  } finally { aiProvider.generateText = orig; }
  const ok = await tp.runForClient(b.id, { now: NOW });
  assert.equal(ok.status, 'fertig');
});

test('KI-Fehler: Status fehler, keine Freigabe, Wiederholung erlaubt', async () => {
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [c.id]);
  H.ai.fail = true;
  try { assert.equal((await tp.runForClient(c.id, { now: NOW })).status, 'fehler'); } finally { H.ai.fail = false; }
  assert.equal((await pool.query('SELECT 1 FROM review_requests WHERE client_id=$1', [c.id])).rows.length, 0);
  assert.equal((await tp.runForClient(c.id, { now: NOW })).status, 'fertig');
});

test('Schalter, Zugriff und manueller Lauf', async () => {
  const d = await H.addClient('Manuell AG');
  assert.equal((await srv.call('PUT', `/api/themenplan/client/${d.id}`, { token: H.clientToken(d.id), body: { aktiv: true } })).status, 403);
  assert.equal((await srv.call('POST', `/api/themenplan/client/${d.id}/erzeugen`, { token: H.advisorToken() })).status, 400);
  assert.equal((await srv.call('PUT', `/api/themenplan/client/${d.id}`, { token: H.advisorToken(), body: { aktiv: true } })).body.aktiv, true);
  const m = await srv.call('POST', `/api/themenplan/client/${d.id}/erzeugen`, { token: H.advisorToken() });
  assert.equal(m.status, 200);
  assert.equal(m.body.status, 'fertig');
  assert.equal((await srv.call('POST', `/api/themenplan/client/${d.id}/erzeugen`, { token: H.advisorToken() })).status, 409);
  const g = await srv.call('GET', `/api/themenplan/client/${d.id}`, { token: H.advisorToken() });
  assert.equal(g.body.aktiv, true);
  assert.equal(g.body.laeufe.length, 1);
});

test('Onboarding: Wahl im Entwurf aktiviert den Themenplan beim Anlegen', async () => {
  const d = await srv.call('POST', '/api/onboarding-drafts', { token: H.advisorToken(), body: { firma: 'Neu Themen AG', kontakt: 'Eva Neu', email: 'eva@neu.ch', sektor: 'kmu', anrede: 'sie', titel: 'Frau', module: ['Text Generator'], themenplan: true } });
  assert.equal(d.status, 201);
  const f = await srv.call('POST', `/api/onboarding-drafts/${d.body.id}/finish`, { token: H.advisorToken(), body: { privacyAcknowledged: true } });
  assert.equal(f.status, 201);
  assert.equal((await pool.query('SELECT themenplan_aktiv FROM clients WHERE id=$1', [f.body.client.id])).rows[0].themenplan_aktiv, true);
});
