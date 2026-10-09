// Empfehlungsprogramm: Partner, Code in der Anfrage, Zuordnung beim Anlegen des Klienten, Provision.
process.env.INQUIRY_KEY = 'testkey123';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv;
const A = () => H.advisorToken();

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  srv = await H.startApp([
    ['/api/inquiry', require('../routes/inquiries').publicRouter],
    ['/api/inquiries', require('../routes/inquiries').advisorRouter],
    ['/api/onboarding-drafts', require('../routes/onboardingDrafts')],
    ['/api/partners', require('../routes/partners')]
  ]);
});
test.after(async () => { await srv.close(); });

test('Partner anlegen, auflisten, nur Beraterin', async () => {
  assert.equal((await srv.call('GET', '/api/partners')).status, 401);
  assert.equal((await srv.call('GET', '/api/partners', { token: H.clientToken(1) })).status, 403);
  assert.equal((await srv.call('POST', '/api/partners', { token: A(), body: { name: '' } })).status, 400);
  const p = await srv.call('POST', '/api/partners', { token: A(), body: { name: 'Treuhand Müller', kontaktEmail: 'info@mueller.ch', code: 'mueller' } });
  assert.equal(p.status, 201);
  assert.equal(p.body.code, 'MUELLER');
  assert.equal((await srv.call('POST', '/api/partners', { token: A(), body: { name: 'Doppelt', code: 'MUELLER' } })).status, 400);
  const auto = await srv.call('POST', '/api/partners', { token: A(), body: { name: 'PR Agentur Zürich' } });
  assert.match(auto.body.code, /^PRAGENTU[0-9A-F]{4}$/);
  const l = await srv.call('GET', '/api/partners', { token: A() });
  assert.equal(l.body.partners.length, 2);
});

test('Anfrage mit ref wird gespeichert, beim Anlegen des Klienten kommt partner_id an', async () => {
  const r = await srv.call('POST', '/api/inquiry', { body: { key: 'testkey123', name: 'Anna Keller', email: 'anna@keller.ch', company: 'Keller AG', message: 'Hallo', ref: 'mueller' } });
  assert.equal(r.status, 200);
  const q = await pool.query(`SELECT id, partner_code FROM inquiries WHERE email='anna@keller.ch'`);
  assert.equal(q.rows[0].partner_code, 'MUELLER');
  const d = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: q.rows[0].id, firma: 'Keller AG', kontakt: 'Anna Keller', email: 'anna@keller.ch', sektor: 'kmu', anrede: 'sie', titel: 'Frau', module: ['Text Generator'] } });
  const f = await srv.call('POST', `/api/onboarding-drafts/${d.body.id}/finish`, { token: A(), body: { privacyAcknowledged: true } });
  assert.equal(f.status, 201);
  const c = await pool.query('SELECT partner_id FROM clients WHERE id=$1', [f.body.client.id]);
  const pid = (await pool.query(`SELECT id FROM partner WHERE code='MUELLER'`)).rows[0].id;
  assert.equal(c.rows[0].partner_id, pid);
});

test('Unbekannter oder inaktiver Code ordnet keinen Partner zu', async () => {
  await srv.call('POST', '/api/inquiry', { body: { key: 'testkey123', name: 'Bea Frei', email: 'bea@frei.ch', message: 'x', ref: 'GIBTESNICHT' } });
  const q = await pool.query(`SELECT id FROM inquiries WHERE email='bea@frei.ch'`);
  const d = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: q.rows[0].id, firma: 'Frei GmbH', kontakt: 'Bea Frei', email: 'bea@frei.ch', sektor: 'kmu', anrede: 'sie', titel: 'Frau', module: ['Text Generator'] } });
  const f = await srv.call('POST', `/api/onboarding-drafts/${d.body.id}/finish`, { token: A(), body: { privacyAcknowledged: true } });
  const c = await pool.query('SELECT partner_id FROM clients WHERE id=$1', [f.body.client.id]);
  assert.equal(c.rows[0].partner_id, null);
});

test('Provision: 10 Prozent des Monatsabos, nur aktive Abos, begrenzt auf 12 Monate', async () => {
  const pid = (await pool.query(`SELECT id FROM partner WHERE code='MUELLER'`)).rows[0].id;
  const mk = async (name, created, limit, status) => (await pool.query(
    `INSERT INTO clients (advisor_id, name, slug, token, partner_id, created_at, monthly_token_limit, subscription_status) VALUES (1,$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name, name + 'slug', name + 'tok', pid, created, limit, status])).rows[0].id;
  await mk('Neu', '2026-09-15T10:00:00Z', 750000, 'active');   // Team CHF 590, Monat 2
  await mk('Alt', '2025-10-20T10:00:00Z', 750000, 'active');   // Monat 13 im Okt 2026, ausserhalb
  await mk('Elf', '2025-11-20T10:00:00Z', 200000, 'active');   // Monat 12 im Okt 2026, Stimme CHF 190
  await mk('Probe', '2026-09-20T10:00:00Z', 750000, 'trial');  // kein aktives Abo
  await mk('Spaet', '2026-11-02T10:00:00Z', 750000, 'active'); // noch nicht angelegt
  const j = await srv.call('GET', `/api/partners/${pid}/provision?month=2026-10`, { token: A() });
  assert.equal(j.status, 200);
  const names = j.body.lines.map(l => l.client).sort();
  assert.deepEqual(names, ['Elf', 'Neu']);
  assert.equal(j.body.totalChf, 59 + 19);
  const neu = j.body.lines.find(l => l.client === 'Neu');
  assert.equal(neu.monatNr, 2);
  assert.equal(neu.provisionChf, 59);
  const csv = await srv.call('GET', `/api/partners/${pid}/provision?month=2026-10&format=csv`, { token: A(), raw: true });
  const text = await csv.text();
  assert.ok(text.includes('Provision CHF') && text.includes('"Neu"') && text.includes('59.00'));
  assert.ok(String(csv.headers.get('content-disposition')).includes('Provision_MUELLER_2026-10.csv'));
  assert.equal((await srv.call('GET', '/api/partners/9999/provision', { token: A() })).status, 404);
});

test('Partner abschalten: Code gilt nicht mehr', async () => {
  const pid = (await pool.query(`SELECT id FROM partner WHERE code='MUELLER'`)).rows[0].id;
  const r = await srv.call('PUT', `/api/partners/${pid}`, { token: A(), body: { aktiv: false } });
  assert.equal(r.body.aktiv, false);
  assert.equal(await require('../lib/partners').byCode('MUELLER'), null);
});
