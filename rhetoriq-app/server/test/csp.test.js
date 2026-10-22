// F-12: CSP nur als Report-Only, Meldeendpunkt, SRI an festen Bibliotheken, pdf.js ohne eval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { DIRECTIVES, router } = require('../lib/cspReport');

test('CSP: nur Report-Only (blockiert nichts), mit report-uri', async () => {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, reportOnly: true, directives: DIRECTIVES } }));
  app.get('/', (req, res) => res.send('ok'));
  app.use('/api/csp-report', router);
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/');
    assert.equal(r.headers.get('content-security-policy'), null, 'scharfe CSP bleibt aus');
    const ro = r.headers.get('content-security-policy-report-only');
    assert.ok(ro && ro.includes("script-src 'self' 'unsafe-inline'") && ro.includes('report-uri /api/csp-report'));
    const rep = await fetch(base + '/api/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://x.test', 'document-uri': base } }) });
    assert.equal(rep.status, 204);
    const bad = await fetch(base + '/api/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kaputt' });
    assert.ok(bad.status === 400 || bad.status === 500, 'kaputter Inhalt bringt keinen Absturz'); 
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('Bibliotheken: lokal ausgeliefert, pdf.js ohne eval', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script src="https:/.test(html), 'keine externen Skripte');
  assert.ok(/getDocument\(\{data:ab,isEvalSupported:false\}\)/.test(html));
  assert.ok(!/getDocument\(\{data:ab\}\)/.test(html));
});
