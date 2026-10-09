// F-20: CSV-Ausgaben ohne Formel-Einschleusung; /health ohne Fehlertext.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { csvCell } = require('../lib/csvSafe');

test('csvCell: Formelzeichen am Anfang werden entschärft, normaler Text bleibt', () => {
  assert.equal(csvCell('=SUMME(A1)'), `"'=SUMME(A1)"`);
  assert.equal(csvCell('+41 79 000'), `"'+41 79 000"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('-1+1'), `"'-1+1"`);
  assert.equal(csvCell('Keller Bau AG'), '"Keller Bau AG"');
  assert.equal(csvCell('mit "Anführung"\nZeile'), '"mit ""Anführung"" Zeile"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(12), '"12"');
});

test('Klientenliste als CSV: Name mit Formel wird als Text ausgegeben', async () => {
  await H.setupBase();
  await H.pool.query(`ALTER TABLE clients ADD COLUMN industry2 TEXT`).catch(() => {});
  await H.pool.query(`INSERT INTO clients (advisor_id, name, slug, token, industry, contact) VALUES (1, '=HYPERLINK("http://x")', 'f1', 't1', 'Bau', '+4179')`);
  const srv = await H.startApp([['/api/clients', require('../routes/clients')]]);
  try {
    const r = await srv.call('GET', '/api/clients/export', { token: H.advisorToken(), raw: true });
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes(`"'=HYPERLINK(""http://x"")"`), t);
    assert.ok(t.includes(`"'+4179"`));
    assert.ok(t.includes('"Bau"'));
  } finally { await srv.close(); }
});
