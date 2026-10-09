// Referenzen: Bezeichnung, Grenzen je Bezeichnung und Modul, Vielfalt der Auswahl.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const L = require('../lib/beispielAuswahl');

let srv;
const A = () => H.advisorToken();
const q = (sql, p) => H.pool.query(sql, p);
const lang = (s) => s + ' ' + 'Dazu kommt ein weiterer Satz, der den Text über zweihundert Zeichen bringt. '.repeat(4);

test.before(async () => {
  await H.setupBase();
  await q(`CREATE TABLE module_examples (id SERIAL PRIMARY KEY, advisor_id INTEGER, module_key TEXT NOT NULL, label TEXT, industry_tag TEXT,
    input_text TEXT NOT NULL, output_text TEXT NOT NULL, rating INTEGER DEFAULT 3, created_at TIMESTAMPTZ DEFAULT NOW(),
    auto_generated BOOLEAN DEFAULT FALSE, source_client_id INTEGER, is_cross_client_shareable BOOLEAN DEFAULT TRUE,
    origin TEXT, status TEXT DEFAULT 'active', tile TEXT, analysis_id INTEGER)`);
  await q(`CREATE TABLE client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
  await setupGenerate(H);
  srv = await H.startApp([
    [null, require('../middleware/readOnly').readOnlyGuard],
    ['/api/analyze', require('../routes/analyze')],
    ['/api/module-examples', require('../routes/moduleExamples')]
  ]);
});
test.after(async () => { await srv.close(); });

test('Grenzen: Handbeispiele werden nie überschrieben, Daumen-hoch-Beispiele werden ersetzt', async () => {
  const a = await H.addClient('Grenze A AG');
  const t = H.clientToken(a.id);
  const url = `/api/module-examples/client/${a.id}`;
  const rate = (id, rating) => srv.call('POST', `/api/analyze/${id}/rate`, { token: t, body: { rating } });
  const mk = async (txt) => (await q(`INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result, feedback_key) VALUES ($1,1,'text-gen','Text',$2,$3,'text-gen-email') RETURNING id`, [a.id, JSON.stringify({ subject: 'Absage' }), txt])).rows[0].id;
  const rows = async () => (await q(`SELECT origin, label FROM module_examples WHERE source_client_id=$1 ORDER BY id`, [a.id])).rows;
  await rate(await mk(lang('Absage eins')), 1); await rate(await mk(lang('Absage zwei')), 1);
  assert.deepEqual((await rows()).map(r => r.label), ['Absage', 'Absage'], 'Bezeichnung aus dem Betreff');
  for (let i = 0; i < 3; i++) assert.equal((await srv.call('POST', url, { token: t, body: { module_key: 'text-gen', title: 'Absage', text: lang('Hand ' + i) } })).status, 201);
  assert.equal((await srv.call('POST', url, { token: t, body: { module_key: 'text-gen', title: 'Absage', text: lang('Hand 4') } })).status, 201);
  let r = await rows();
  assert.equal(r.filter(x => x.origin === 'client').length, 4);
  assert.equal(r.filter(x => x.origin === 'thumbs').length, 1, 'ein Daumen-Beispiel wurde ersetzt');
  assert.equal((await srv.call('POST', url, { token: t, body: { module_key: 'text-gen', title: 'Absage', text: lang('Hand 5') } })).status, 201);
  const sechs = await srv.call('POST', url, { token: t, body: { module_key: 'text-gen', title: 'Absage', text: lang('Hand 6') } });
  assert.equal(sechs.status, 409);
  assert.equal(sechs.body.error, 'Für diese Bezeichnung sind 5 Beispiele abgelegt. Löschen Sie eines, um ein neues hinzuzufügen.');
  assert.equal((await rows()).filter(x => x.origin === 'client').length, 5, 'kein Handbeispiel gelöscht');
  await rate(await mk(lang('Absage drei')), 1);
  r = await rows();
  assert.equal(r.filter(x => x.origin === 'thumbs').length, 0, 'neues Daumen-Beispiel verdrängt kein Handbeispiel');
  assert.equal(r.length, 5);
  assert.equal((await srv.call('POST', url, { token: t, body: { module_key: 'text-gen', title: 'Einladung', text: lang('Einladung eins') } })).status, 201, 'andere Bezeichnung bleibt möglich');
});

test('Bezeichnung: ändern, auf 60 Zeichen kürzen, Grenze greift beim Umbenennen, fremde Beispiele unerreichbar', async () => {
  const a = await H.addClient('Grenze B AG');
  const b = await H.addClient('Grenze C AG');
  const url = (c) => `/api/module-examples/client/${c.id}`;
  const c1 = await srv.call('POST', url(a), { token: H.clientToken(a.id), body: { module_key: 'text-gen', title: 'x'.repeat(100), text: lang('Lang') } });
  assert.ok(c1.body.label.length <= L.MAX_BEZEICHNUNG);
  const ren = await srv.call('PUT', `${url(a)}/${c1.body.id}/label`, { token: H.clientToken(a.id), body: { label: 'Kondolenz' } });
  assert.equal(ren.status, 200); assert.equal(ren.body.label, 'Kondolenz');
  assert.equal((await srv.call('PUT', `${url(a)}/${c1.body.id}/label`, { token: H.clientToken(b.id), body: { label: 'Hack' } })).status, 403);
  assert.equal((await srv.call('PUT', `${url(b)}/${c1.body.id}/label`, { token: H.clientToken(b.id), body: { label: 'Hack' } })).status, 404);
  assert.equal((await srv.call('PUT', `${url(a)}/${c1.body.id}/label`, { token: A(), body: { label: 'Von der Beraterin' } })).status, 200);
  for (let i = 0; i < 5; i++) await srv.call('POST', url(a), { token: H.clientToken(a.id), body: { module_key: 'text-gen', title: 'Voll', text: lang('Voll ' + i) } });
  assert.equal((await srv.call('PUT', `${url(a)}/${c1.body.id}/label`, { token: H.clientToken(a.id), body: { label: 'Voll' } })).status, 409);
});

test('Bezeichnung aus dem Auftrag: Betreff oder Thema, sonst Textart', () => {
  assert.equal(L.bezeichnungAusAuftrag({ subject: 'Absage Bewerbung' }, 'email', 'Text'), 'Absage Bewerbung');
  assert.equal(L.bezeichnungAusAuftrag({ text: 'x' }, 'email', 'Text'), 'E-Mail');
  assert.equal(L.bezeichnungAusAuftrag({}, null, 'Rede und Auftritt'), 'Rede und Auftritt');
});

test('Vielfalt: pro Bezeichnung ein Beispiel, ähnliche nicht doppelt; Bezeichnung zählt stärker; Handbeispiele zuerst', () => {
  const k = (id, label, out, extra = {}) => ({ id, label, input_text: '', output_text: out, rating: 3, created_at: new Date(2026, 0, id), ...extra });
  const kand = [
    k(1, 'Absage', 'Wir bedauern Ihnen mitteilen zu müssen dass die Stelle besetzt wurde Absage Bewerbung'),
    k(2, 'Absage', 'Leider müssen wir die Bewerbung absagen Absage Stelle Bewerbung'),
    k(3, 'Absage Offerte', 'Wir bedauern Ihnen mitteilen zu müssen dass die Stelle besetzt wurde Absage Bewerbung'),
    k(4, 'Einladung', 'Wir laden Sie herzlich zur Bewerbung Stelle Gespräch Absage ein')
  ];
  const r = L.waehle(kand, { data: { text: 'Absage Bewerbung Stelle' } }).beispiele.map(x => x.id);
  assert.equal(r.filter(i => i === 1 || i === 2).length, 1, 'gleiche Bezeichnung nur einmal');
  assert.ok(!(r.includes(1) && r.includes(3)), 'nahezu gleicher Text nicht doppelt');
  const m = L.bewerte([k(1, 'Sauna', 'Eröffnung Hotel'), k(2, '', 'Sauna Eröffnung Hotel')], { data: { text: 'Sauna' } });
  assert.ok(m[0].rel > m[1].rel);
  const h = L.bewerte([k(1, 'A', 'Sauna', { origin: 'thumbs' }), k(2, 'B', 'Sauna', { origin: 'client' })], { data: { text: 'Sauna' } });
  assert.ok(h[1].punkte > h[0].punkte);
});
