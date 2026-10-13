// Oberfläche des Eingangs: Aufbau der Seite Assistent, Reihenfolge, Skriptblock, Schreibregeln, DE/EN-Paare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const indexJs = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };
const seite = () => html.slice(html.indexOf('<div class="page" id="page-assistent">'), html.indexOf('<!-- VIDEOS -->'));

test('Skriptblock ist gültig und steht nach der Warteliste, vor der Lernkurve', () => {
  assert.doesNotThrow(() => new vm.Script(block('rq-eingang-js')));
  const i = html.indexOf('<script id="rq-eingang-js">');
  assert.ok(i > html.indexOf('<script id="rq-warteliste-js">'));
  assert.ok(i < html.indexOf('<script id="rq-lernkurve-js">'));
  assert.ok(!/innerHTML/.test(block('rq-eingang-js')), 'kein innerHTML');
  assert.ok(block('rq-eingang-js').includes('window.rqAssistentOpen') && block('rq-eingang-js').includes('isAdv'));
});

test('Seite Assistent: eine Zeile, Beispiele eingeklappt, Eingang vor Heute vor den Kalender-Zeilen', () => {
  const s = seite();
  for (const id of ['as-in', 'as-mic', 'as-st', 'as-log', 'as-ex', 'eg-eingang', 'eg-pills', 'eg-list', 'eg-heute', 'eg-kal', 'tp-root', 'eg-mehr']) assert.ok(s.includes(`id="${id}"`), 'fehlt: ' + id);
  assert.ok(/<details class="eg-bsp"[^>]*>\s*<summary>Beispiele<\/summary>/.test(s), 'Beispiele eingeklappt');
  assert.ok(s.indexOf('id="as-ex"') > s.indexOf('<summary>Beispiele</summary>'));
  assert.ok(/<form class="as-row eg-asrow"[^>]*>[\s\S]*id="as-in"[\s\S]*id="as-mic"[\s\S]*<\/form>/.test(s), 'Eingabe und Mikrofon in einer Zeile');
  assert.ok(/<div class="as-log" id="as-log"[^>]*><\/div>/.test(s), 'Protokoll ist leer, solange nichts gesagt wurde');
  assert.ok(!/<details[^>]*id="eg-kal"[^>]*\sopen/.test(s), 'Kalender standardmässig zugeklappt');
  const pos = (id) => s.indexOf(`id="${id}"`);
  assert.ok(pos('as-in') < pos('eg-eingang') && pos('eg-eingang') < pos('eg-heute') && pos('eg-heute') < pos('eg-kal') && pos('eg-kal') < pos('eg-mehr'));
  assert.equal((s.match(/class="rq-chip"/g) || []).length, 9);
});

test('Der Assistent legt beim Öffnen keine Übersichtsnachricht mehr ins Protokoll', () => {
  const a = block('rq-assistent-js');
  const o = a.slice(a.indexOf('window.rqAssistentOpen=function'), a.indexOf('async function ensureClients'));
  assert.ok(!/summary\(\)/.test(o));
});

test('Eingang: Filter, Leerzustand, Aktionen und Aktualisierung', () => {
  const b = block('rq-eingang-js');
  for (const t of ['Alle', 'Freigaben', 'Anfragen', 'E-Mails', 'Termine', 'Warteliste', 'Alles erledigt. Nichts Neues.', 'Freigeben', 'Antworten', 'Ansehen', 'Öffnen', '/api/assistent/eingang', '/gelesen', '/api/tagesplan/plan', 'setInterval', '60000', 'document.hidden', "'aria-pressed'", 'aria-label', 'gestern ']) assert.ok(b.includes(t), 'fehlt: ' + t);
  assert.ok(/openReviewPanel/.test(b) && /loadAdvisorDashboard/.test(b));
});

test('Schreibregeln in Eingang und Seite', () => {
  const texte = [...(block('rq-eingang-js') + block('rq-xpairs-eingang') + seite()).matchAll(/['">]([^'"<>\n]{8,})['"<]/g)].map(x => x[1]).filter(t => /\s/.test(t) && !/function|var |=>|\{|;|px|rgba?\(/.test(t));
  assert.ok(texte.length > 10);
  for (const t of texte) {
    assert.ok(!/ß/.test(t), 'ß: ' + t);
    assert.ok(!/[–—―]/.test(t), 'Gedankenstrich: ' + t);
    assert.ok(!/, nicht\b|nicht [^.]{0,40}, sondern|\bsondern\b/.test(t), 'Gegenüberstellung: ' + t);
  }
  assert.ok(!/font-style:\s*italic|<em>|<i>/.test(block('rq-eingang-js') + html.slice(html.indexOf('<style id="rq-eingang-css">'), html.indexOf('<script id="rq-lernkurve-js">'))), 'keine Kursivschrift');
});

test('DE/EN-Paare', () => {
  const win = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(block('rq-xpairs-eingang'), { window: win });
  const de = new Set(win.RQ_EXTRA_PAIRS.map(p => p[0]));
  for (const t of ['Eingegangen', 'Beispiele', 'Alles erledigt. Nichts Neues.', 'Freigeben', 'Antworten', 'Ansehen', 'Öffnen', 'Kalender öffnen', 'Nächster Termin']) assert.ok(de.has(t), 'Paar fehlt: ' + t);
  for (const p of win.RQ_EXTRA_PAIRS) assert.ok(p[0] && p[1] && p.length === 2);
  assert.ok(html.indexOf('<script id="rq-xpairs-eingang">') < html.indexOf('<script id="rq-i18n">'));
});

test('Routen sind eingehängt, Mail-Empfang hat ein eigenes Grössenlimit', () => {
  assert.ok(indexJs.includes("'/api/assistent/eingang'") && indexJs.includes("'/api/eingang'"));
  assert.ok(indexJs.indexOf("'/api/assistent/eingang'") < indexJs.indexOf("'/api/assistent'"), 'Eingang vor dem Assistenten');
  assert.ok(indexJs.includes("'/api/eingang/mail', express.json({ limit: '300kb' })"));
});
