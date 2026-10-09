// Module und Textarten pro Klient: serverseitige Sperre bei der Generierung, Speichern durch die Beraterin,
// Newsletter-Erstellung aus der Themenwahl bei gesperrter Textart.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;
const MA = require('../lib/moduleAccess');

let srv, c1, c2, fremd;
const gen = (token, module, extra = {}, path = '/api/analyze') =>
  srv.call('POST', path, { token, body: { module, data: { text: 'Einladung zum Anlass' }, ...extra } });
const setMods = (id, mods, arten) => pool.query('UPDATE clients SET enabled_modules=$1, enabled_textarten=$2 WHERE id=$3', [mods, arten, id]);

test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query('CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN themenplan_aktiv BOOLEAN DEFAULT FALSE').catch(() => {});
  for (const col of ['capital_markets_enabled BOOLEAN DEFAULT FALSE', 'hotel_enabled BOOLEAN DEFAULT FALSE']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  c1 = await H.addClient('Eins AG'); c2 = await H.addClient('Zwei AG');
  fremd = await H.addClient('Fremd AG');
  await pool.query('UPDATE clients SET advisor_id=2 WHERE id=$1', [fremd.id]);
  srv = await H.startApp([
    ['/api/analyze', require('../routes/analyze')],
    ['/api/clients', require('../routes/clients')],
    ['/api/themenplan', require('../routes/themenplan')]
  ]);
  H.ai.reply = 'Ein kurzer Text.';
});
test.after(async () => { await srv.close(); });

test('Gesperrtes Modul gibt 403 ohne KI-Kosten, in POST / und /stream', async () => {
  await setMods(c1.id, ['brand-voice', 'text-gen'], null);
  const tok = H.clientToken(c1.id);
  H.ai.calls.length = 0;
  for (const path of ['/api/analyze', '/api/analyze/stream']) {
    const r = await gen(tok, 'rm', {}, path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error, 'Dieses Modul ist für Ihr Konto nicht freigeschaltet. Bitte wenden Sie sich an Ihre Beraterin.');
  }
  assert.equal(H.ai.calls.length, 0, 'keine KI-Kosten');
  const ok = await gen(tok, 'text-gen', { instructionsKey: 'text-gen-email' });
  assert.equal(ok.status, 200);
});

test('Keine Auswahl (null) erlaubt alles; Brand Voice ist immer erlaubt', async () => {
  await setMods(c2.id, null, null);
  const tok = H.clientToken(c2.id);
  for (const m of ['rm', 'sparring', 'presentation', 'text-gen']) assert.equal((await gen(tok, m)).status, 200, m);
  await setMods(c1.id, ['text-gen'], null);
  const r = await gen(H.clientToken(c1.id), 'brand-voice-update');
  assert.notEqual(r.status, 403);
});

test('Bündel und alte Einzelschlüssel: Gespräch-Schlüssel und Rede-Schlüssel schalten die Einzelmodule frei', async () => {
  const { toEnabledModules } = require('../lib/moduleCatalog');
  await setMods(c1.id, toEnabledModules(['Gespräch']), null);
  const tok = H.clientToken(c1.id);
  for (const m of ['pre-meeting', 'st', 'si', 'sparring', 'debrief']) assert.equal((await gen(tok, m)).status, 200, m);
  assert.equal((await gen(tok, 'presentation')).status, 403);
  assert.equal((await gen(tok, 'text-gen')).status, 403);
  await setMods(c1.id, toEnabledModules(['Rede und Auftritt']), null);
  assert.equal((await gen(tok, 'presentation')).status, 200);
  await setMods(c1.id, ['brand-voice', 'vs-gen'], null);
  assert.equal((await gen(tok, 'vs-gen')).status, 200, 'alter Einzelschlüssel');
});

test('Textart: erlaubte Kachel geht, gesperrte gibt 403 ohne KI-Kosten, null erlaubt alle', async () => {
  await setMods(c1.id, ['brand-voice', 'text-gen'], ['email', 'linkedin']);
  const tok = H.clientToken(c1.id);
  H.ai.calls.length = 0;
  assert.equal((await gen(tok, 'text-gen', { instructionsKey: 'text-gen-email' })).status, 200);
  const n = H.ai.calls.length;
  for (const path of ['/api/analyze', '/api/analyze/stream']) {
    const r = await gen(tok, 'text-gen', { instructionsKey: 'text-gen-press' }, path);
    assert.equal(r.status, 403, path);
    assert.match(r.body.error, /Textart/);
  }
  assert.equal((await gen(tok, 'text-gen')).status, 403, 'ohne Kachelangabe gilt Freie Textart');
  assert.equal(H.ai.calls.length, n, 'keine KI-Kosten');
  await setMods(c1.id, ['brand-voice', 'text-gen'], null);
  assert.equal((await gen(tok, 'text-gen', { instructionsKey: 'text-gen-press' })).status, 200);
});

test('Beraterin und Prüfsatz bleiben unberührt', async () => {
  await setMods(c1.id, ['brand-voice'], []);
  const r = await gen(H.advisorToken(), 'text-gen', { clientId: c1.id, instructionsKey: 'text-gen-press' });
  assert.equal(r.status, 200);
  const req = { pruefsatz: true, user: { role: 'client', clientId: c1.id } };
  assert.equal(await MA.sperrt(req, { status() { throw new Error('nicht erwartet'); } }, 'text-gen', 'text-gen-press'), false);
  assert.equal(MA.modulErlaubt(['brand-voice'], 'router'), true);
});

test('Speichern durch die Beraterin des Klienten, Fremd-Klient und Klient selbst abgelehnt', async () => {
  const put = (token, id, body) => srv.call('PUT', `/api/clients/${id}/modules-config`, { token, body });
  const r = await put(H.advisorToken(), c1.id, { modules: ['brand-voice', 'text-gen'], textarten: ['email', 'brief'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.enabled_textarten, ['email', 'brief']);
  // Feld fehlt: Textarten bleiben
  const r2 = await put(H.advisorToken(), c1.id, { modules: ['brand-voice', 'text-gen', 'risk'] });
  assert.deepEqual(r2.body.enabled_textarten, ['email', 'brief']);
  // null = alle
  const r3 = await put(H.advisorToken(), c1.id, { modules: ['brand-voice', 'text-gen'], textarten: null });
  assert.equal(r3.body.enabled_textarten, null);
  assert.equal((await put(H.advisorToken(), c1.id, { modules: ['brand-voice'], textarten: ['faxe'] })).status, 400);
  assert.equal((await put(H.advisorToken(), fremd.id, { modules: ['brand-voice'], textarten: ['email'] })).status, 404);
  assert.equal((await put(H.clientToken(c1.id), c1.id, { modules: ['rm'], textarten: ['email'] })).status, 403);
  const st = await srv.call('GET', `/api/clients/${c1.id}/cm-status`, { token: H.clientToken(c1.id) });
  assert.equal(st.status, 200);
  assert.equal(st.body.enabled_textarten, null);
  await setMods(c1.id, ['brand-voice', 'text-gen'], ['email']);
  const st2 = await srv.call('GET', `/api/clients/${c1.id}/cm-status`, { token: H.clientToken(c1.id) });
  assert.deepEqual(st2.body.enabled_textarten, ['email']);
});

test('Newsletter-Erstellung aus der Themenwahl bei gesperrter Textart: 403 und keine KI-Kosten', async () => {
  await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [c1.id]);
  await setMods(c1.id, null, ['email']);
  const tok = H.clientToken(c1.id);
  H.ai.calls.length = 0;
  const r = await srv.call('POST', `/api/themenplan/auswahl/${c1.id}`, { token: tok, body: { monat: '2026-11', auswahl: [{ idx: 0 }] } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Newsletter/);
  assert.equal(H.ai.calls.length, 0);
  const m = await srv.call('GET', `/api/themenplan/mein/${c1.id}`, { token: tok });
  assert.equal(m.body.newsletterErlaubt, false);
  await setMods(c1.id, null, ['newsletter']);
  const r2 = await srv.call('POST', `/api/themenplan/auswahl/${c1.id}`, { token: tok, body: { monat: '2026-11', auswahl: [{ idx: 0 }] } });
  assert.notEqual(r2.status, 403, 'erlaubt: scheitert höchstens später (kein Plan)');
});
