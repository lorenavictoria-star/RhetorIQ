// Datenschutz (DSG): Schriften und Skripte kommen vom eigenen Server, keine Drittserver beim Laden der Seiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const DRITT = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/;
const dateien = fs.readdirSync(PUBLIC).filter(f => /\.(html|js)$/.test(f) && !/ 2\.(html|js)$/.test(f));

test('public: keine Verweise auf Drittserver für Schriften und Skripte', () => {
  assert.ok(dateien.length > 5);
  for (const f of dateien) {
    const m = fs.readFileSync(path.join(PUBLIC, f), 'utf8').match(DRITT);
    assert.equal(m, null, `${f} verweist auf ${m && m[0]}`);
  }
});

test('jede referenzierte /vendor/-Datei existiert (auch innerhalb der Vendor-CSS)', () => {
  const quellen = dateien.map(f => path.join(PUBLIC, f));
  const vendor = path.join(PUBLIC, 'vendor');
  for (const f of fs.readdirSync(vendor)) if (f.endsWith('.css')) quellen.push(path.join(vendor, f));
  quellen.push(path.join(vendor, 'tabler', 'tabler-icons.min.css'));
  let n = 0;
  for (const q of quellen) {
    for (const m of fs.readFileSync(q, 'utf8').matchAll(/\/vendor\/[A-Za-z0-9_\-./]+/g)) {
      n++;
      assert.ok(fs.existsSync(path.join(PUBLIC, m[0])), `${path.basename(q)}: ${m[0]} fehlt`);
    }
  }
  assert.ok(n >= 15);
  assert.ok(fs.existsSync(path.join(vendor, 'LICENSES.txt')));
});

test('/vendor wird mit richtigem Content-Type und langer Cache-Dauer ausgeliefert', async () => {
  const app = express();
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/app\.use\('\/vendor', express\.static\(/.test(src) && /max-age=31536000, immutable/.test(src));
  app.use('/vendor', express.static(path.join(PUBLIC, 'vendor'), { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const [p, typ] of [['/vendor/fonts.css', 'text/css'], ['/vendor/js/three.min.js', 'javascript'], ['/vendor/tabler/fonts/tabler-icons.woff2', 'font/woff2']]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.ok((r.headers.get('content-type') || '').includes(typ), `${p}: ${r.headers.get('content-type')}`);
    }
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
