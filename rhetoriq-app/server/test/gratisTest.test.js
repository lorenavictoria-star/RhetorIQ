// Gratis-Test pro Klient: Schalter der Beraterin, Start beim ersten Login, 14 Tage und 10 Texte, danach 402.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;

const { DataType } = require('pg-mem');
H.mem.public.registerFunction({ name: 'date_trunc', args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz, implementation: (u, t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } });
process.env.ABO_PFLICHT_AB = '2026-01-01T00:00:00Z';

let srv;
const set = (id, sql, ...p) => pool.query(`UPDATE clients SET ${sql} WHERE id=$1`, [id, ...p]);

test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN gratis_test BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN trial_start TIMESTAMPTZ').catch(() => {});
  await pool.query('CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  srv = await H.startApp([['/api/clients', require('../routes/clients')], ['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

const gen = (token, clientId) => srv.call('POST', '/api/analyze', { token, body: { module: 'text-gen', clientId, data: { text: 'Einladung', tile: 'email' } } });
const abo = require('../lib/abo');
const tage = (n) => new Date(Date.now() - n * 86400000);

test('Gratis-Test: ohne Schalter bleibt die Abo-Sperre, mit Schalter läuft der Test', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Test AG');
  await set(c.id, "subscription_status='trial'");
  assert.equal((await gen(H.clientToken(c.id))).status, 402, 'ohne Schalter gesperrt');
  await set(c.id, 'gratis_test=true');
  const r = await gen(H.clientToken(c.id));
  assert.equal(r.status, 200, 'mit Schalter erlaubt');
  assert.match(r.body.quotaWarning || '', /Gratis-Test: noch 9 von 10 Texten/);
  const { rows } = await pool.query('SELECT trial_start FROM clients WHERE id=$1', [c.id]);
  assert.ok(rows[0].trial_start, 'Test beim ersten Text gestartet');
});

test('Gratis-Test: Start beim ersten Login, nur mit Schalter', async () => {
  const a = await H.addClient('Login AG'), b = await H.addClient('Login Ohne AG');
  await set(a.id, 'gratis_test=true');
  await abo.starteTest(a.id); await abo.starteTest(b.id);
  const g = async (id) => (await pool.query('SELECT trial_start FROM clients WHERE id=$1', [id])).rows[0].trial_start;
  assert.ok(await g(a.id)); assert.equal(await g(b.id), null);
  const first = await g(a.id);
  await abo.starteTest(a.id);
  assert.equal(String(await g(a.id)), String(first), 'zweiter Login startet nicht neu');
});

test('Gratis-Test: nach 10 Texten 402 trial_texte, nach 14 Tagen 402 trial_abgelaufen', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Grenze AG');
  await set(c.id, "subscription_status='trial', gratis_test=true, trial_start=$2", new Date());
  for (let i = 0; i < 10; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, result) VALUES ($1,1,'text-gen','x')`, [c.id]);
  const r = await gen(H.clientToken(c.id));
  assert.equal(r.status, 402); assert.equal(r.body.grund, 'trial_texte');
  const d = await H.addClient('Frist AG');
  await set(d.id, "subscription_status='trial', gratis_test=true, trial_start=$2", tage(15));
  const r2 = await gen(H.clientToken(d.id));
  assert.equal(r2.status, 402); assert.equal(r2.body.grund, 'trial_abgelaufen');
  const e = await H.addClient('Frist ok AG');
  await set(e.id, "subscription_status='trial', gratis_test=true, trial_start=$2", tage(13));
  assert.equal((await gen(H.clientToken(e.id))).status, 200, 'Tag 13 läuft noch');
});

test('Gratis-Test: Beraterin ausgenommen, Abo hebt den Test auf', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Berater AG');
  await set(c.id, "subscription_status='trial', gratis_test=true, trial_start=$2", tage(30));
  assert.equal((await gen(H.advisorToken ? H.advisorToken() : H.clientToken(c.id), c.id)).status, H.advisorToken ? 200 : 402);
  await set(c.id, "subscription_status='active'");
  assert.equal((await gen(H.clientToken(c.id))).status, 200, 'mit Abo kein Limit durch den Test');
});

test('Schalter: Beraterin setzt und liest den Gratis-Test, Einschalten startet neu', async () => {
  const c = await H.addClient('Schalter AG');
  const tok = H.advisorToken ? H.advisorToken() : null;
  if (!tok) return;
  let r = await srv.call('PUT', `/api/clients/${c.id}/gratis-test`, { token: tok, body: { an: true } });
  assert.equal(r.status, 200);
  r = await srv.call('GET', `/api/clients/${c.id}/gratis-test`, { token: tok });
  assert.equal(r.body.an, true); assert.equal(r.body.gestartet, false); assert.equal(r.body.texteMax, 10);
  await set(c.id, 'trial_start=$2', tage(20));
  await srv.call('PUT', `/api/clients/${c.id}/gratis-test`, { token: tok, body: { an: true } });
  const { rows } = await pool.query('SELECT trial_start FROM clients WHERE id=$1', [c.id]);
  assert.equal(rows[0].trial_start, null, 'Neustart beim erneuten Einschalten');
  await srv.call('PUT', `/api/clients/${c.id}/gratis-test`, { token: tok, body: { an: false } });
  r = await srv.call('GET', `/api/clients/${c.id}/gratis-test`, { token: tok });
  assert.equal(r.body.an, false);
});

test('Gratis-Test: Überarbeitung nach Feedback zählt nicht als Text, hat aber eine Obergrenze', async () => {
  H.ai.reply = 'Ein Text.';
  const c = await H.addClient('Überarbeitung AG');
  await set(c.id, "subscription_status='trial', gratis_test=true, trial_start=$2", new Date());
  const rev = () => srv.call('POST', '/api/analyze', { token: H.clientToken(c.id), body: { module: 'text-gen', data: { text: 'Einladung', tile: 'email' }, followUp: { note: 'kürzer bitte', previousResult: 'Alt' } } });
  // eine Überarbeitung wird gespeichert, ohne die 10 Texte zu verbrauchen
  assert.equal((await rev()).status, 200);
  let st = await abo.teststand(await abo.clientRow(c.id));
  assert.equal(st.texteGenutzt, 0); assert.equal(st.ueberarbeitungen, 1);
  // 10 echte Texte aufgebraucht: neue Texte gesperrt, Überarbeitung geht weiter
  for (let i = 0; i < 10; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, result) VALUES ($1,1,'text-gen','x')`, [c.id]);
  assert.equal((await gen(H.clientToken(c.id))).body.grund, 'trial_texte');
  assert.equal((await rev()).status, 200, 'Überarbeitung nach den 10 Texten weiterhin möglich');
  // Obergrenze (3 je Text = 30)
  for (let i = 0; i < 30; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, result, ueberarbeitung) VALUES ($1,1,'text-gen','x',true)`, [c.id]);
  const r = await rev();
  assert.equal(r.status, 402); assert.equal(r.body.grund, 'trial_ueberarbeitungen');
});
