// Arbeitssprache eines Klienten: Deutsch (Standard) oder English (British, Corporate). Regelwerk, Prüfung, Auswahl in der Verwaltung.
process.env.ABO_PFLICHT_AB = '2099-01-01T00:00:00Z';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;
const AS = require('../lib/arbeitssprache');
const lint = require('../lib/lint');

let srv, en, de;
const adv = () => H.advisorToken();
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query('CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  for (const col of ['capital_markets_enabled BOOLEAN DEFAULT FALSE', 'hotel_enabled BOOLEAN DEFAULT FALSE']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  en = await H.addClient('Corporate AG');
  de = await H.addClient('Deutsche GmbH');
  srv = await H.startApp([
    ['/api/clients', require('../routes/clients')],
    ['/api/analyze', require('../routes/analyze')]
  ]);
  H.ai.reply = 'A short text.';
});
test.after(async () => { await srv.close(); });

test('Ausgabesprache: die Sprache im Auftrag gewinnt, sonst die Arbeitssprache', () => {
  assert.equal(AS.ausgabeSprache({ language: 'English' }, null), 'en');
  assert.equal(AS.ausgabeSprache({ language: 'Deutsch' }, { arbeitssprache: 'en' }), 'de');
  assert.equal(AS.ausgabeSprache({}, { arbeitssprache: 'en' }), 'en');
  assert.equal(AS.ausgabeSprache({}, { arbeitssprache: 'de' }), 'de');
  assert.equal(AS.ausgabeSprache(null, null), 'de');
  assert.equal(AS.ausgabeSprache({ language: 'Français' }, { arbeitssprache: 'en' }), 'de', 'andere Sprachen bleiben beim bisherigen Regelwerk');
  assert.equal(AS.gueltig('en'), 'en');
  assert.equal(AS.gueltig('fr'), null);
});

test('Englisches Regelwerk: British English, gleiche Rangfolge, keine deutschen Schreibregeln', () => {
  const r = AS.regeln('en');
  assert.match(r.rules, /ORDER OF PRECEDENCE/);
  assert.match(r.rules, /British English/);
  assert.match(r.rules, /-ise/);
  assert.ok(!/Schweizer Schreibweise|«ss»|Komma/.test(r.rules.replace(/with a comma|comma/gi, '')), 'keine deutschen Regeln im englischen Block');
  assert.equal((r.rules.match(/—/g) || []).length, 1, 'das Regelwerk nennt den langen Strich nur einmal, als Verbot');
  assert.match(r.head, /CLIENT VOICE/);
  assert.match(AS.regeln('de').rules, /RANGFOLGE/);
});

test('Prüfung auf Englisch: amerikanische Schreibweise, Bürosprache, Gegenüberstellung; britische Formen bleiben unbeanstandet', () => {
  const schlecht = lint.lintText('We leverage synergies to organize the center. It is not just a tool, but a partnership. Please do not hesitate to reach out.', { sprache: 'English' });
  const arten = schlecht.map(h => h.art);
  assert.ok(arten.includes('amerikanisch'));
  assert.ok(arten.includes('buerosprech_en'));
  assert.ok(arten.includes('gegenueberstellung'));
  const gut = lint.lintText('We organise the centre with colour, analyse the programme and favour a plain style.', { sprache: 'English' });
  assert.equal(gut.length, 0, JSON.stringify(gut));
  assert.ok(!lint.lintText('Wir analysieren das Zentrum.', { sprache: 'Deutsch' }).some(h => h.art === 'amerikanisch'), 'Deutsch wird nicht auf Englisch geprüft');
});

test('Anlegen und Ändern der Arbeitssprache, Rechte, Anzeige', async () => {
  const neu = await srv.call('POST', '/api/clients', { token: adv(), body: { name: 'Neue Corporate AG', privacyAcknowledged: true, arbeitssprache: 'en' } });
  assert.equal(neu.status, 201);
  assert.equal(neu.body.arbeitssprache, 'en');
  const normal = await srv.call('POST', '/api/clients', { token: adv(), body: { name: 'Normal AG', privacyAcknowledged: true } });
  assert.notEqual(normal.body.arbeitssprache, 'en');
  const liste = await srv.call('GET', '/api/clients', { token: adv() });
  assert.equal(liste.body.find(c => c.id === neu.body.id).arbeitssprache, 'en');
  const put = await srv.call('PUT', `/api/clients/${de.id}/arbeitssprache`, { token: adv(), body: { sprache: 'en' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.arbeitssprache, 'en');
  assert.equal((await srv.call('PUT', `/api/clients/${de.id}/arbeitssprache`, { token: adv(), body: { sprache: 'fr' } })).status, 400);
  assert.equal((await srv.call('PUT', `/api/clients/${de.id}/arbeitssprache`, { token: H.clientToken(de.id), body: { sprache: 'en' } })).status, 403);
  assert.equal((await srv.call('PUT', '/api/clients/999999/arbeitssprache', { token: adv(), body: { sprache: 'en' } })).status, 404);
  const st = await srv.call('GET', `/api/clients/${de.id}/cm-status`, { token: H.clientToken(de.id) });
  assert.equal(st.body.arbeitssprache, 'en', 'der Klient sieht seine Arbeitssprache');
  await srv.call('PUT', `/api/clients/${de.id}/arbeitssprache`, { token: adv(), body: { sprache: 'de' } });
  assert.equal((await srv.call('GET', `/api/clients/${de.id}/cm-status`, { token: H.clientToken(de.id) })).body.arbeitssprache, 'de');
});

test('Auftrag eines englisch arbeitenden Klienten: englisches Regelwerk, Brand-Voice-Rahmen und Sprachvorgabe; deutscher Klient unverändert', async () => {
  await srv.call('PUT', `/api/clients/${en.id}/arbeitssprache`, { token: adv(), body: { sprache: 'en' } });
  await pool.query("INSERT INTO company_memory (client_id, advisor_id, memory_type, content) VALUES ($1, 1, 'brand_voice', 'KERN\nPlain and direct.')", [en.id]).catch(() => {});
  H.ai.calls.length = 0;
  const r = await srv.call('POST', '/api/analyze', { token: H.clientToken(en.id), body: { module: 'text-gen', data: { text: 'Invitation to the Q4 update' }, instructionsKey: 'text-gen-email' } });
  assert.equal(r.status, 200);
  const sys = JSON.stringify(H.ai.calls.map(c => c.system));
  assert.ok(sys.includes('ORDER OF PRECEDENCE'), 'englisches Regelwerk');
  assert.ok(!sys.includes('RANGFOLGE (bei Widersprüchen'), 'kein deutsches Regelwerk');
  assert.ok(sys.includes('OUTPUT LANGUAGE: This client works in English'));
  assert.ok(sys.includes('CLIENT VOICE'), 'englischer Brand-Voice-Rahmen');
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(en.id), body: { module: 'text-gen', data: { text: 'Einladung', language: 'Deutsch' }, instructionsKey: 'text-gen-email' } });
  assert.ok(JSON.stringify(H.ai.calls.map(c => c.system)).includes('RANGFOLGE (bei Widersprüchen'), 'ausdrücklich gewähltes Deutsch gewinnt');
  const d2 = await H.addClient('Nur Deutsch AG');
  H.ai.calls.length = 0;
  await srv.call('POST', '/api/analyze', { token: H.clientToken(d2.id), body: { module: 'text-gen', data: { text: 'Einladung' }, instructionsKey: 'text-gen-email' } });
  const sysDe = JSON.stringify(H.ai.calls.map(c => c.system));
  assert.ok(sysDe.includes('RANGFOLGE (bei Widersprüchen'));
  assert.ok(!sysDe.includes('OUTPUT LANGUAGE: This client works in English'));
});
