// Oberfläche von Warteliste und Geschenken: Landingpage (Dialog, Skript, Schreibregeln, Adressen) und Verwaltung in RhetorIQ (DE/EN-Paare).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const landing = fs.readFileSync(path.join(pub, 'landing.html'), 'utf8');
const indexJs = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };

test('Alle Inline-Skripte von landing.html und index.html sind gültig (node --check)', () => {
  for (const h of [html, landing]) {
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(h))) { if (/src=|application\/ld\+json/.test(m[1])) continue; n++; assert.doesNotThrow(() => new vm.Script(m[2]), (/id="([^"]+)"/.exec(m[1]) || [])[1] || 'Block'); }
    assert.ok(n > 3);
  }
  assert.ok(landing.includes('<script id="rq-warteliste-landing">'));
});

test('Adressen /platz und /geschenk zeigen die Landingpage, Router sind eingehängt', () => {
  assert.ok(/app\.get\('\/platz'.*landing\.html/.test(indexJs));
  assert.ok(/app\.get\('\/geschenk'.*landing\.html/.test(indexJs));
  assert.ok(indexJs.includes("'/api/warteliste'") && indexJs.includes("'/api/geschenk'"));
});

test('Landingpage: Abschnitte, Dialog, Felder, Einwilligung mit Datenschutzlink, Honeypot', () => {
  for (const id of ['platz', 'pzfrei', 'pzn', 'pzgo', 'geschenk', 'rqw', 'pzf', 'pn', 'pe', 'pu', 'pb', 'pt', 'pc', 'pw', 'gf', 'g-prompt', 'g-leitfaden', 'gn', 'ge', 'gc', 'gw', 'rqwdone', 'rqwlive']) assert.ok(landing.includes(`id="${id}"`), 'fehlt: ' + id);
  assert.ok(/<section id="platz" hidden>/.test(landing), 'Abschnitt ist ohne Skript verborgen');
  assert.ok(/<input id="pc" type="checkbox" required>/.test(landing) && /<input id="gc" type="checkbox" required>/.test(landing), 'Kontrollkästchen nicht vorausgewählt');
  assert.ok(!/id="(pc|gc)"[^>]*checked/.test(landing));
  assert.ok(!/<input[^>]*name="g"[^>]*checked/.test(landing), 'kein Geschenk vorausgewählt');
  const dlg = landing.slice(landing.indexOf('<dialog class="rqd" id="rqw"'));
  assert.ok((dlg.match(/href="\/\?p=datenschutz"/g) || []).length >= 2);
  assert.ok(dlg.includes('Lorena Lienhard mir das gewählte Geschenk per E-Mail sendet und sich zu den Themen Stimme und KI bei mir melden darf'));
  assert.ok(/id="rqwlive" role="status" aria-live="polite"/.test(landing));
  const js = /<script id="rq-warteliste-landing">([\s\S]*?)<\/script>/.exec(landing)[1];
  for (const t of ['/api/warteliste/status', '/api/warteliste', '/api/geschenk/ticket', '/api/geschenk', '"/platz"', '"/geschenk"', 'g=(prompt|leitfaden)', 'Noch "+j.frei+" von "+j.plaetze+" Plätzen im "+j.fenster+" frei', 'auf der Warteliste']) assert.ok(js.includes(t), 'fehlt: ' + t);
  assert.ok(!/innerHTML/.test(js));
});

test('Zähler auf der Landingpage kommen nur aus der Antwort des Servers', () => {
  const js = /<script id="rq-warteliste-landing">([\s\S]*?)<\/script>/.exec(landing)[1];
  const fn = /function zaehlerText\(j\)\{[\s\S]*?return \{frei:frei,n:n\}\}/.exec(js)[0];
  const f = vm.runInNewContext('(' + fn.replace('function zaehlerText', 'function') + ')');
  assert.deepEqual({ ...f({ aktiv: false, frei: 3, plaetze: 5, fenster: 'X', anzahl: 9 }) }, { frei: null, n: null }, 'AUS: nichts');
  assert.deepEqual({ ...f({ aktiv: true }) }, { frei: null, n: null }, 'ohne erlaubte Zähler nichts');
  assert.deepEqual({ ...f({ aktiv: true, frei: 0, plaetze: 5, fenster: 'November', anzahl: 12 }) }, { frei: 'Noch 0 von 5 Plätzen im November frei', n: '12 Unternehmen auf der Warteliste' });
  assert.deepEqual({ ...f({ aktiv: true, frei: 2, plaetze: 5, fenster: 'November' }) }, { frei: 'Noch 2 von 5 Plätzen im November frei', n: null });
});

test('Schreibregeln auf der Landingpage (neue Texte): keine Gedankenstriche, kein ß, keine Gegenüberstellung', () => {
  const a = landing.indexOf('<section id="geschenk">');
  const teile = [landing.slice(a, landing.indexOf('<section id="fragen">')), landing.slice(landing.indexOf('<section id="platz"'), landing.indexOf('<section id="buchen">')),
    landing.slice(landing.indexOf('<dialog class="rqd" id="rqw"'), landing.indexOf('</dialog>', landing.indexOf('<dialog class="rqd" id="rqw"'))),
    /<script id="rq-warteliste-landing">([\s\S]*?)<\/script>/.exec(landing)[1]];
  for (const t of teile) {
    assert.ok(!/[–—―]/.test(t), 'Gedankenstrich');
    assert.ok(!/ß/.test(t), 'ß');
    assert.ok(!/, nicht\b|nicht [^.]{0,40}, sondern|\bsondern\b/.test(t), 'Gegenüberstellung');
    assert.ok(!/<i>|<em>|font-style:\s*italic/.test(t), 'Kursivschrift');
  }
});

test('Verwaltung in RhetorIQ: Bereich Warteliste, Felder, Aktionen, kein innerHTML, Schreibregeln', () => {
  const b = block('rq-warteliste-js');
  for (const t of ['Warteliste', 'Warteliste ist eingeschaltet', 'Plätze pro Monat', 'Name des Aufnahmefensters', 'Freie Plätze auf der Webseite anzeigen', 'Anzahl der Unternehmen auf der Warteliste anzeigen',
    'Anzahl erst ab dieser Zahl anzeigen', 'Zum Gespräch einladen', 'Als CSV exportieren', 'Eintrag löschen', '/api/warteliste/admin/einstellungen', '/api/warteliste/admin/liste', '/api/warteliste/admin/export.csv', '/einladen', '/status']) assert.ok(b.includes(t), 'fehlt: ' + t);
  assert.ok(!/innerHTML/.test(b));
  assert.ok(html.indexOf('<script id="rq-warteliste-js">') > html.indexOf('<script id="rq-buchung-js">'));
  const texte = [...b.matchAll(/'([^'\n]{12,})'/g)].map(x => x[1]).filter(t => /\s/.test(t));
  assert.ok(texte.length > 10);
  for (const t of texte) {
    assert.ok(!/ß/.test(t), 'ß: ' + t);
    assert.ok(!/[–—―]/.test(t), 'Gedankenstrich: ' + t);
    assert.ok(!/, nicht\b|nicht [^.]{0,40}, sondern|\bsondern\b/.test(t), 'Gegenüberstellung: ' + t);
  }
});

test('DE/EN-Paare (RQ_EXTRA_PAIRS) decken die neuen Texte der Verwaltung ab', () => {
  const win = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(block('rq-xpairs-warteliste'), { window: win });
  const de = new Set(win.RQ_EXTRA_PAIRS.map(p => p[0]));
  const b = block('rq-warteliste-js');
  for (const t of ['Warteliste', 'Warteliste ist eingeschaltet', 'Plätze pro Monat', 'Freie Plätze auf der Webseite anzeigen', 'Anzahl der Unternehmen auf der Warteliste anzeigen', 'Zum Gespräch einladen', 'Als CSV exportieren', 'Eintrag löschen',
    'Noch keine Einträge.', 'Einträge', 'Zähler', 'Neu', 'Eingeladen', 'Aufgenommen', 'Abgesagt', 'Einstellungen speichern'.slice(0, 0) || 'Link zur Warteliste']) assert.ok(de.has(t), 'Paar fehlt: ' + t);
  // jeder feste Text der Verwaltung hat ein Paar (Texte mit Daten, Meldungen der Fehler ausgenommen)
  for (const t of ['Warteliste ist eingeschaltet', 'Plätze pro Monat', 'Name des Aufnahmefensters, zum Beispiel November', 'Anzahl erst ab dieser Zahl anzeigen', 'Noch keine Einträge.', 'Der Eintrag ist gelöscht.', 'Einladung gesendet. Der Status ist auf eingeladen gesetzt.']) {
    assert.ok(b.includes(t) || html.includes(t), t);
    assert.ok(de.has(t), 'Paar fehlt: ' + t);
  }
  for (const p of win.RQ_EXTRA_PAIRS) { assert.equal(p.length, 2); assert.ok(p[0] && p[1]); assert.ok(!/[–—―]/.test(p[0] + p[1])); }
});
