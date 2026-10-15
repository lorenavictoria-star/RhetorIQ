const test = require('node:test');
const assert = require('node:assert');
const ev = require('../lib/siteEvents');
test('Besucherzähler: nur bekannte Namen, Berichtszeilen', async () => {
  assert.ok(ev.gueltig('view_home') && ev.gueltig('cta_test_hero'));
  assert.ok(!ev.gueltig('x') && !ev.gueltig('') && !ev.gueltig(5) && !ev.gueltig('__proto__'));
  const calls = [];
  const pool = { query: async (sql, p) => { calls.push([sql, p]); return { rows: [] }; } };
  assert.strictEqual(await ev.record(pool, 'nope'), false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(await ev.record(pool, 'view_home'), true);
  assert.ok(calls.some(([s, p]) => /INSERT INTO site_events/.test(s) && p[0] === 'view_home'));
  assert.ok(ev.reportLines({}).join('\n').includes('Noch keine Zählung'));
  const t = ev.reportLines({ view_home: 12, test_submit: 3 }).join('\n');
  assert.ok(t.includes('Besuche Startseite: 12') && t.includes('Stimmtest abgeschickt: 3'));
});
