// Strikte Trennung der Klienten bei Strukturvorlagen (module_examples).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { scopeSql } = require('../lib/exampleScope');
const { setupGenerate, systemText } = require('../test-support/genSetup');

let srv;
const A = () => H.advisorToken();
const q = (sql, p) => H.pool.query(sql, p);

test.before(async () => {
  await H.setupBase();
  await q(`CREATE TABLE module_examples (id SERIAL PRIMARY KEY, advisor_id INTEGER, module_key TEXT NOT NULL, label TEXT, industry_tag TEXT,
    input_text TEXT NOT NULL, output_text TEXT NOT NULL, rating INTEGER DEFAULT 3, created_at TIMESTAMPTZ DEFAULT NOW(),
    auto_generated BOOLEAN DEFAULT FALSE, source_client_id INTEGER, is_cross_client_shareable BOOLEAN DEFAULT TRUE)`);
  await q(`CREATE TABLE client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
  await setupGenerate(H);
  srv = await H.startApp([
    ['/api/analyze', require('../routes/analyze')],
    ['/api/module-examples', require('../routes/moduleExamples')]
  ]);
});
test.after(async () => { await srv.close(); });

const ex = (o) => q(`INSERT INTO module_examples (advisor_id, module_key, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable)
  VALUES (1,$1,$2,$3,$4,false,$5,$6) RETURNING id`, [o.module || 'text-gen', o.input || 'in', o.output, o.rating || 3, o.source ?? null, o.share]).then(r => r.rows[0].id);
const visible = (clientId) => q(`SELECT output_text FROM module_examples WHERE advisor_id=1 AND module_key='text-gen' AND auto_generated=false AND rating>=3 AND ${scopeSql(1)}`, [clientId]).then(r => r.rows.map(x => x.output_text).sort());

test('Vorlagen: eigene Klientenvorlage nur für den eigenen Klienten, freigegebene für alle, Beraterinnen-Vorlage für alle', async () => {
  const a = await H.addClient('Trenn A AG');
  const b = await H.addClient('Trenn B AG');
  await ex({ output: 'VORLAGE-BERATERIN', share: true });
  await ex({ output: 'NUR-A', source: a.id, share: false });
  await ex({ output: 'FREIGEGEBEN-VON-B', source: b.id, share: true });
  assert.deepEqual(await visible(a.id), ['FREIGEGEBEN-VON-B', 'NUR-A', 'VORLAGE-BERATERIN']);
  assert.deepEqual(await visible(b.id), ['FREIGEGEBEN-VON-B', 'VORLAGE-BERATERIN']);
  assert.deepEqual(await visible(null), ['FREIGEGEBEN-VON-B', 'VORLAGE-BERATERIN'], 'ohne Klient nur Freigegebenes');
});

test('Vorlagen: Anlegen mit Klientenbezug ist standardmässig nicht klientenübergreifend', async () => {
  const a = await H.addClient('Trenn C AG');
  const r1 = await srv.call('POST', '/api/module-examples', { token: A(), body: { module_key: 'text-gen', input_text: 'i', output_text: 'x', source_client_id: a.id } });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.is_cross_client_shareable, false);
  assert.equal(r1.body.source_client_id, a.id);
  const r2 = await srv.call('POST', '/api/module-examples', { token: A(), body: { module_key: 'text-gen', input_text: 'i', output_text: 'y', source_client_id: a.id, is_cross_client_shareable: true } });
  assert.equal(r2.body.is_cross_client_shareable, true);
  const r3 = await srv.call('POST', '/api/module-examples', { token: A(), body: { module_key: 'text-gen', input_text: 'i', output_text: 'z' } });
  assert.equal(r3.body.is_cross_client_shareable, true, 'Vorlage der Beraterin ohne Klientenbezug');
  assert.equal((await srv.call('POST', '/api/module-examples', { token: A(), body: { module_key: 'text-gen', input_text: 'i', output_text: 'z', source_client_id: 99999 } })).status, 404);
});

test('Auto-Import und Import: Beispiele bekommen den Klienten und sind nicht klientenübergreifend', async () => {
  const a = await H.addClient('Trenn D AG');
  await q(`INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result) VALUES ($1,1,'text-gen','Text',$2,$3)`, [a.id, JSON.stringify({ text: 'Briefing zum Thema' }), 'Ein Ergebnis für den Klienten D']);
  await q('ALTER TABLE clients ADD COLUMN IF NOT EXISTS training_imported_at TIMESTAMPTZ');
  const r = await srv.call('POST', `/api/module-examples/auto-import/${a.id}`, { token: A() });
  assert.equal(r.status, 200);
  const { rows } = await q('SELECT source_client_id, is_cross_client_shareable, auto_generated FROM module_examples WHERE source_client_id=$1', [a.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_cross_client_shareable, false);
  assert.equal(rows[0].auto_generated, true);
});

test('Vorlagen: beide Generierungsrouten und der Vorschlag für Anweisungen filtern mit scopeSql', () => {
  const fs = require('fs');
  const a = fs.readFileSync(require.resolve('../routes/analyze'), 'utf8');
  assert.equal((a.match(/\$\{scopeSql\(4\)\}/g) || []).length, 2);
  assert.ok(fs.readFileSync(require.resolve('../routes/modulePrompts'), 'utf8').includes('scopeSql(3)'));
});

test('Bewertung eines Klienten verändert nur Vorlagen aus seinen Texten, nicht die für andere', async () => {
  const a = await H.addClient('Trenn E AG');
  const b = await H.addClient('Trenn F AG');
  const own = await ex({ output: 'E-EIGEN', source: a.id, share: false, rating: 3 });
  const other = await ex({ output: 'F-EIGEN', source: b.id, share: false, rating: 3 });
  const tmpl = await ex({ output: 'E-VORLAGE-BERATERIN', share: true, rating: 3 });
  const { rows } = await q(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result, feedback_key) VALUES ($1,1,'text-gen','Text','Ergebnis','text-gen-email') RETURNING id`, [a.id]);
  const res = await srv.call('POST', `/api/analyze/${rows[0].id}/rate`, { token: H.clientToken(a.id), body: { rating: 1 } });
  assert.equal(res.status, 200);
  const get = async (id) => (await q('SELECT rating FROM module_examples WHERE id=$1', [id])).rows[0].rating;
  for (let i = 0; i < 40 && (await get(own)) === 3; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(await get(own), 4, 'eigene Vorlage steigt');
  assert.equal(await get(other), 3, 'Vorlage eines anderen Klienten bleibt');
  assert.equal(await get(tmpl), 3, 'Vorlage der Beraterin bleibt');
});

test('Ende zu Ende: der Auftrag enthält nur Vorlagen des eigenen Klienten und freigegebene', async () => {
  const a = await H.addClient('Trenn G AG');
  const b = await H.addClient('Trenn H AG');
  await ex({ module: 'text-gen', output: 'AUFBAU-BERATERIN-ZZ', share: true });
  await ex({ module: 'text-gen', output: 'AUFBAU-NUR-G-ZZ', source: a.id, share: false });
  await ex({ module: 'text-gen', output: 'AUFBAU-NUR-H-ZZ', source: b.id, share: false });
  const gen = async (cl) => {
    H.ai.calls.length = 0;
    H.ai.reply = 'Ein längerer Text. '.repeat(20);
    const r = await srv.call('POST', '/api/analyze', { token: A(), body: { clientId: cl.id, module: 'text-gen', data: { text: 'Einladung zum Anlass', tile: 'email' } } });
    assert.equal(r.status, 200);
    return H.ai.calls.map(systemText).join('\n');
  };
  const forA = await gen(a);
  assert.ok(forA.includes('AUFBAU-BERATERIN-ZZ') && forA.includes('AUFBAU-NUR-G-ZZ'));
  assert.ok(!forA.includes('AUFBAU-NUR-H-ZZ'), 'Text eines anderen Klienten landet nicht im Auftrag');
  const forB = await gen(b);
  assert.ok(forB.includes('AUFBAU-NUR-H-ZZ') && !forB.includes('AUFBAU-NUR-G-ZZ'));
  // freigeben: dann gilt die Vorlage für alle
  await q(`UPDATE module_examples SET is_cross_client_shareable=true WHERE output_text='AUFBAU-NUR-G-ZZ'`);
  assert.ok((await gen(b)).includes('AUFBAU-NUR-G-ZZ'));
  // die erzeugten Texte werden als Beispiele des eigenen Klienten abgelegt, nicht klientenübergreifend
  for (let i = 0; i < 40; i++) { const { rows } = await q('SELECT 1 FROM module_examples WHERE auto_generated=true AND source_client_id=$1', [a.id]); if (rows.length) break; await new Promise(r => setTimeout(r, 25)); }
  const { rows: auto } = await q('SELECT is_cross_client_shareable FROM module_examples WHERE auto_generated=true AND source_client_id=$1', [a.id]);
  assert.ok(auto.length >= 1 && auto.every(x => x.is_cross_client_shareable === false));
});
