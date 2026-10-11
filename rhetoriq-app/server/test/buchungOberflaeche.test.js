// Oberfläche der Terminbuchung: Einstellungen in RhetorIQ und Dialog der Landingpage (Struktur, Schreibregeln, DE/EN-Paare, gültige Skripte).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const landing = fs.readFileSync(path.join(pub, 'landing.html'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };

test('Alle Skriptblöcke von index.html und landing.html sind gültig', () => {
  for (const h of [html, landing]) {
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(h))) { if (/src=/.test(m[1])) continue; assert.doesNotThrow(() => new vm.Script(m[2]), (/id="([^"]+)"/.exec(m[1]) || [])[1] || 'Block'); }
  }
});

test('Einstellungen: Bereich, Schalter, Felder, Liste mit Absagen, öffentlicher Link, kein innerHTML', () => {
  const b = block('rq-buchung-js');
  for (const t of ['Terminbuchung', 'Buchungen sind eingeschaltet', 'Gesprächsdauer in Minuten', 'Mindestvorlauf in Stunden', 'Arbeitsfenster pro Wochentag', 'Kommende Buchungen', 'Absagen', 'Öffentlicher Link', 'Videolink', '/api/buchung/admin/einstellungen', '/api/buchung/admin/liste/']) assert.ok(b.includes(t), 'fehlt: ' + t);
  assert.ok(!/innerHTML/.test(b));
  assert.ok(html.indexOf('<script id="rq-buchung-js">') > html.indexOf('<script id="rq-kalendersync-js">'));
});

test('Schreibregeln im Bereich Terminbuchung', () => {
  const b = block('rq-buchung-js') + block('rq-xpairs-buchung');
  const texte = [...b.matchAll(/'([^'\n]{12,})'/g)].map(x => x[1]).filter(t => /\s/.test(t));
  assert.ok(texte.length > 10);
  for (const t of texte) {
    assert.ok(!/ß/.test(t), 'ß: ' + t);
    assert.ok(!/[–—―]/.test(t), 'Gedankenstrich: ' + t);
    assert.ok(!/, nicht\b|nicht [^.]{0,40}, sondern|\bsondern\b/.test(t), 'Gegenüberstellung: ' + t);
  }
});

test('DE/EN-Paare decken die Texte ab', () => {
  const win = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(block('rq-xpairs-buchung'), { window: win });
  const de = new Set(win.RQ_EXTRA_PAIRS.map(p => p[0]));
  for (const t of ['Terminbuchung', 'Buchungen sind eingeschaltet', 'Kommende Buchungen', 'Absagen', 'Öffentlicher Link', 'Link kopieren', 'Einstellungen speichern', 'Bestätigungsmail']) assert.ok(de.has(t), 'Paar fehlt: ' + t);
  for (const p of win.RQ_EXTRA_PAIRS) assert.ok(p[0] && p[1] && p.length === 2);
});

test('Landingpage: Dialog mit Terminwahl, Einwilligung, Textlink zum Formular, aria-live, Fallback, kein Gedankenstrich', () => {
  for (const id of ['rqdays', 'rqtimes', 'rqbf', 'bc', 'rqtoform', 'rqlive', 'rqdone', 'rqmg', 'rqf', 'fw', 'bw']) assert.ok(landing.includes(`id="${id}"`), 'fehlt: ' + id);
  assert.ok(landing.includes('href="/?p=datenschutz"'));
  assert.ok(landing.includes('Lieber eine Nachricht senden'));
  assert.ok(landing.includes('Termin buchen'));
  assert.ok(landing.includes('Eine Bestätigung mit Kalendereintrag ist unterwegs'));
  assert.ok(/id="rqlive" role="status" aria-live="polite"/.test(landing));
  assert.ok(/Schweizer Zeit/.test(landing));
  assert.ok(landing.includes('/api/buchung/slots') && landing.includes('/api/inquiry'));
  assert.ok(/<form id="rqf" novalidate>/.test(landing), 'das bisherige Formular ist ohne Skript sichtbar');
  const neu = landing.slice(landing.indexOf('<dialog class="rqd"'));
  assert.ok(!/[–—―]/.test(neu.slice(0, neu.indexOf('</dialog>'))), 'Gedankenstrich im Dialog');
  const js = landing.slice(landing.indexOf('var SUBTXT'), landing.indexOf('var mt=/^#t='));
  assert.ok(!/[–—―]/.test(js), 'Gedankenstrich im Skript');
  assert.ok(!/ß|, nicht\b|\bsondern\b/.test(js));
  assert.ok(!/italic|<em>|<i>/.test(landing.slice(landing.indexOf('dialog.rqd{max-height'), landing.indexOf('dialog.rqd{max-height') + 2200)));
});
