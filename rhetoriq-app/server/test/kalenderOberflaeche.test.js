// Oberfläche «Kalender verbinden»: Block vorhanden und gültig, Texte nach den Schreibregeln, Anleitungen, DE/EN-Paare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };

test('Block rq-kalendersync-js steht vor rq-lernkurve-js und alle Script-Blöcke sind gültig', () => {
  assert.ok(html.indexOf('<script id="rq-kalendersync-js">') > html.indexOf('<script id="rq-tagesplan-js">'));
  assert.ok(html.indexOf('<script id="rq-kalendersync-js">') < html.indexOf('<script id="rq-lernkurve-js">'));
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (/src=/.test(m[1])) continue;
    n++;
    assert.doesNotThrow(() => new vm.Script(m[2]), 'Syntaxfehler in ' + ((/id="([^"]+)"/.exec(m[1]) || [])[1] || 'Block'));
  }
  assert.ok(n > 50);
});

test('Oberfläche: Status, Knöpfe, Anleitungen, ehrlicher Hinweis zur Verzögerung und Datenschutz', () => {
  const b = block('rq-kalendersync-js');
  for (const t of ['Mit Google verbunden', 'Mit Google verbinden', 'Neu synchronisieren', 'Trennen', 'Weitere Kalender (nur lesen)', 'Google-Zugang ist noch nicht eingerichtet',
    'Öffentlicher Kalender', 'Link kopieren', 'Kalender veröffentlichen', 'Freigegebene Kalender', 'ICS-Link', 'Einstellungen', 'Accounts', 'Account hinzufügen',
    'aktualisieren sich bei Apple und Microsoft mit Verzögerung', 'Der Google-Kalender ist dagegen sofort aktuell', 'Der Link ist geheim', 'Kalender nicht erreichbar seit', 'Letzte Synchronisation']) {
    assert.ok(b.includes(t), 'fehlt: ' + t);
  }
  assert.ok(b.includes('textContent') || b.includes("text:"), 'Texte aus Daten werden als Text gesetzt');
  assert.ok(!/innerHTML/.test(b), 'kein innerHTML');
  assert.ok(!/localStorage|sessionStorage/.test(b), 'Links und Tokens werden nicht im Browser gespeichert');
});

test('Schreibregeln im neuen Block: Schweizer Rechtschreibung, keine Gedankenstriche, keine Gegenüberstellungen, keine Kursivschrift', () => {
  const b = block('rq-kalendersync-js');
  const texte = [...b.matchAll(/'([^'\n]{12,})'/g)].map(x => x[1]).filter(t => /\s/.test(t) && /[a-zäöü]/.test(t));
  assert.ok(texte.length > 30);
  for (const t of texte) {
    assert.ok(!/ß/.test(t), 'ß: ' + t);
    assert.ok(!/[–—―]/.test(t), 'Gedankenstrich: ' + t);
    assert.ok(!/, nicht\b|nicht [^.]{0,40}, sondern|\bsondern\b/.test(t), 'Gegenüberstellung: ' + t);
  }
  assert.ok(!/font-style\s*:\s*italic|<em>|<i>/.test(b));
  const css = html.slice(html.indexOf('.ks-sec{'), html.indexOf('.ks-sec{') + 1500);
  assert.ok(!/italic/.test(css));
});

test('DE/EN-Paare (RQ_EXTRA_PAIRS) decken die Texte des neuen Bereichs ab', () => {
  const m = /<script id="rq-xpairs-tagesplan">([\s\S]*?)<\/script>/.exec(html);
  const win = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(m[1], { window: win });
  const de = new Set(win.RQ_EXTRA_PAIRS.map(p => p[0]));
  for (const t of ['Kalender verbinden', 'Google Kalender', 'Mit Google verbinden', 'Neu synchronisieren', 'Trennen', 'Weitere Kalender (nur lesen)', 'Kalender hinzufügen', 'Entfernen', 'Link des Kalenders',
    'Letzte Synchronisation: {1}', 'Fehler seit {1}: {2}', 'Kalender nicht erreichbar seit {1}. {2}', 'Zuletzt gelesen: {1}', 'Google-Zugang ist noch nicht eingerichtet']) {
    assert.ok(de.has(t), 'Paar fehlt: ' + t);
  }
  for (const p of win.RQ_EXTRA_PAIRS) assert.ok(p[0] && p[1] && p.length === 2, 'Paar unvollständig: ' + p[0]);
});

test('Tagesplan-Kalender: Besetzt-Zeiten werden schreibgeschützt und gestreift dargestellt', () => {
  const b = block('rq-tagesplan-js');
  assert.ok(b.includes("art:'fremd'"));
  assert.ok(b.includes("b.art==='fremd'"));
  assert.ok(b.includes('nur lesen'));
  assert.ok(html.includes('.tp-b.fremd{') && html.includes('repeating-linear-gradient(45deg'));
});
