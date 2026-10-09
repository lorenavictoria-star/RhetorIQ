// Tagesbudgets für Hintergrundfunktionen: Summen aus usage_log, Überschreiben per Umgebungsvariable, eine Mail pro Funktion und Tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const budget = require('../lib/budget');

let srv;
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await H.pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  srv = await H.startApp([['/api/help-chat', require('../routes/helpChat')], ['/api/memory-suggest', require('../routes/memorySuggest')]]);
});
test.after(async () => { await srv.close(); });
const log = (module, usd, when) => H.pool.query(`INSERT INTO usage_log (module, model, input_tokens, cost_usd, created_at) VALUES ($1,'claude-haiku-4-5-20251001',1,$2,COALESCE($3, NOW()))`, [module, usd, when || null]);
const clear = () => H.pool.query('DELETE FROM usage_log');

test('Standardgrenzen: wie vorgegeben, per Umgebungsvariable überschreibbar', () => {
  assert.equal(budget.limitFor('waechter'), 0.10);
  assert.equal(budget.limitFor('messungen'), 1.00);
  assert.equal(budget.limitFor('themenplan'), 5.00);
  assert.equal(budget.limitFor('schnelltest'), 2.00);
  assert.equal(budget.limitFor('lernvorschlaege'), 2.00);
  assert.equal(budget.limitFor('hilfe-chat'), 2.00);
  process.env.BUDGET_THEMENPLAN_USD = '8.5';
  process.env.BUDGET_HILFE_CHAT_USD = 'quatsch';
  assert.equal(budget.limitFor('themenplan'), 8.5);
  assert.equal(budget.limitFor('hilfe-chat'), 2.00, 'ungültiger Wert: Standard');
  delete process.env.BUDGET_THEMENPLAN_USD; delete process.env.BUDGET_HILFE_CHAT_USD;
  assert.equal(budget.envName('hilfe-chat'), 'BUDGET_HILFE_CHAT_USD');
});

test('allow: zählt nur die Module der Funktion und nur den heutigen Tag', async () => {
  await clear(); H.brevoMails.length = 0;
  await log('lernen-korrektur', 1.2); await log('lernen-nachfrage', 0.5);
  assert.equal((await budget.allow('lernvorschlaege')).ok, true, 'zusammen 1.70, Grenze 2.00');
  await log('lernen-daumen', 0.4);
  const r = await budget.allow('lernvorschlaege');
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.spent - 2.1) < 1e-6);
  await log('themenplan', 4.99);
  assert.equal((await budget.allow('themenplan')).ok, true, 'andere Funktion, eigene Grenze');
  await clear();
  await log('waechter', 3, new Date(Date.now() - 36 * 3600 * 1000));
  assert.equal((await budget.allow('waechter')).ok, true, 'Kosten von gestern zählen nicht');
  assert.equal((await budget.allow('gibt-es-nicht')).ok, true);
});

test('Mail an Lorena genau einmal pro Funktion und Tag, mit Hinweis auf die Umgebungsvariable', async () => {
  await clear(); H.brevoMails.length = 0;
  await log('schnelltest', 2.5);
  await budget.allow('schnelltest'); await budget.allow('schnelltest'); await budget.allow('schnelltest');
  const m = H.brevoMails.filter(x => /Tagesbudget/.test(x.subject));
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /Stimm-Schnelltest pausiert/);
  assert.match(m[0].text, /BUDGET_SCHNELLTEST_USD/);
  assert.doesNotMatch(m[0].text, /[–—]/, 'keine Gedankenstriche');
  await log('comm-profile', 1.5);
  await budget.allow('messungen');
  assert.equal(H.brevoMails.filter(x => /Tagesbudget/.test(x.subject)).length, 2, 'andere Funktion: eigene Mail');
});

test('Zürcher Tagesbeginn liegt im Sommer zwei Stunden und im Winter eine Stunde vor Mitternacht UTC', () => {
  const sommer = budget.tagesbeginn(new Date('2026-07-15T10:00:00Z'));
  assert.equal(sommer.start.toISOString(), '2026-07-14T22:00:00.000Z');
  const winter = budget.tagesbeginn(new Date('2026-01-15T10:00:00Z'));
  assert.equal(winter.start.toISOString(), '2026-01-14T23:00:00.000Z');
});

test('Hilfe-Chat und Dokumenttyp-Vorschlag: bei erreichtem Budget keine KI, freundliche Antwort bzw. manuelle Auswahl', async () => {
  await clear(); H.ai.calls.length = 0; H.ai.reply = 'Antwort';
  const c = await H.addClient('Budgetfirma');
  const ok = await srv.call('POST', '/api/help-chat', { token: H.clientToken(c.id), body: { question: 'Wo finde ich die Ablage?' } });
  assert.equal(ok.status, 200);
  assert.equal(H.ai.calls[0].meter.module, 'hilfe-chat');
  await log('hilfe-chat', 2.2); await log('memory-vorschlag', 1.1);
  H.ai.calls.length = 0;
  const nein = await srv.call('POST', '/api/help-chat', { token: H.clientToken(c.id), body: { question: 'Noch eine Frage?' } });
  assert.equal(nein.status, 429);
  assert.match(nein.body.error, /für heute ausgeschöpft/);
  const ms = await srv.call('POST', '/api/memory-suggest', { token: H.advisorToken(), body: { filename: 'a.txt', text: 'Ein Text über unser Unternehmen.' } });
  assert.deepEqual(ms.body, { type: null, label: '', confidence: 0, summary: '' });
  assert.equal(H.ai.calls.length, 0, 'keine KI-Aufrufe bei erreichtem Budget');
});

test('Einordnung einer Nachfrage: bei erreichtem Budget gilt der Wunsch im Wortlaut, ohne KI', async () => {
  await clear(); H.ai.calls.length = 0; H.ai.reply = '{"category":"TON","observation":"Wärmer schreiben."}';
  const { classify } = require('../lib/followupLearning');
  const normal = await classify(1, 'Bitte wärmer');
  assert.equal(normal.category, 'TON');
  assert.equal(H.ai.calls.length, 1);
  await log('lernen-nachfrage', 2.5);
  H.ai.calls.length = 0;
  const knapp = await classify(1, 'Bitte kürzer');
  assert.deepEqual(knapp, { category: 'SONSTIGES', observation: 'Bitte kürzer' });
  assert.equal(H.ai.calls.length, 0);
});
