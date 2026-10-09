// F-08: Fehler in async-Routen, Upload-Grenzen, Fehlerbehandler.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('../test-support/harness');
require('../lib/asyncErrors');
const { errorHandler } = require('../lib/errorHandler');

let srv;
test.before(async () => {
  await H.setupBase();
  await H.addClient('Upload AG');
  const r = express.Router();
  r.get('/boom', async () => { throw new Error('async kaputt'); });
  r.get('/ok', async (req, res) => { res.json({ ok: true }); });
  r.get('/sync', () => { throw new Error('sync kaputt'); });
  srv = await H.startApp([['/t', r], ['/api/onboard', require('../routes/onboard')], ['', errorHandler]]);
});
test.after(async () => { await srv.close(); });

test('F-08 Fehler in async-Routen werden als 500 beantwortet, der Prozess lebt weiter', async () => {
  assert.equal((await srv.call('GET', '/t/boom')).status, 500);
  assert.equal((await srv.call('GET', '/t/sync')).status, 500);
  const ok = await srv.call('GET', '/t/ok');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

function form(n, size) {
  const fd = new FormData();
  for (let i = 0; i < n; i++) fd.append('files', new Blob(['a'.repeat(size)], { type: 'text/plain' }), `f${i}.txt`);
  return fd;
}

test('F-08 Upload: mehr als 5 Dateien oder über 15 MB werden abgelehnt (413), kleine Uploads erreichen die Route', async () => {
  const tok = H.advisorToken();
  const many = await fetch(srv.base + '/api/onboard', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form(6, 10) });
  assert.equal(many.status, 413);
  const big = await fetch(srv.base + '/api/onboard', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form(1, 16 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const okReq = await fetch(srv.base + '/api/onboard', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form(2, 10) });
  assert.notEqual(okReq.status, 413, 'zwei kleine Dateien passieren die Upload-Grenze');
});
