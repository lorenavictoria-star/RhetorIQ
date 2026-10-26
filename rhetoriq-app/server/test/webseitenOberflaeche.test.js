// Oberfläche Webseiten-Batch und Faktenblatt: Textsuche in public/index.html, Syntax der Skriptblöcke.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };
const web = block('rq-webseiten-js');
const fakt = block('rq-faktenblatt-js');

test('Skriptblöcke sind gültig', () => {
  assert.doesNotThrow(() => new vm.Script(web));
  assert.doesNotThrow(() => new vm.Script(fakt));
  assert.doesNotThrow(() => new vm.Script(block('rq-einheiten-js')));
});

test('Reiter, Ids und Beschriftungen vorhanden', () => {
  for (const s of ['ws-tab-web', "'Webseiten'", 'Seitenpaket erstellen', 'Konsistenz prüfen', 'Seiten von Webadresse laden', 'Word herunterladen', 'wsw-go', 'wsw-check', 'wsw-frueher', 'Prüfung über alle Webseiten', "'restaurants'"]) assert.ok(web.includes(s), s);
  for (const s of ['Öffnungszeiten', 'Zeile hinzufügen', 'Fehlende Angaben', 'Vorschau: Auf einen Blick', 'Strukturdaten kopieren', 'faktenStruktur', 'oeffnungszeiten']) assert.ok(fakt.includes(s), s);
  assert.ok(html.includes('rqFaktenblatt.einhaengen'));
});

test('Routen werden aufgerufen', () => {
  for (const r of ['/api/webseiten/seitentypen', '/api/webseiten/paket', '/api/webseiten/check', '/api/webseiten/pakete', '/api/webseiten/import/liste', 'export.docx']) assert.ok(web.includes(r) || fakt.includes(r), r);
  assert.ok(fakt.includes('/auf-einen-blick') && fakt.includes('/json-ld'));
});

test('Serverdaten nur über textContent, kein innerHTML', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(web + fakt));
});

test('Schreibregeln: keine Gedankenstriche, kein ß, keine Kursivschrift', () => {
  const s = web + fakt;
  assert.ok(!/[–—]/.test(s)); assert.ok(!/ß/.test(s)); assert.ok(!/<i>|<em>|font-style:\s*italic/.test(s));
});
