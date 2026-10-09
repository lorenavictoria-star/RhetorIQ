// Kosteninventar: Preise aus meter.js, Szenario 10 Klienten und 400 Texte, automatische Funktionen, Vollständigkeit der Schlüssel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const inv = require('../lib/kostenInventar');
const meter = require('../lib/meter');

test('Kosten je Vorgang kommen aus costUsd (meter.js)', () => {
  const c = inv.INVENTAR['lernen-nachfrage'].calls()[0];
  assert.equal(inv.kostenJeVorgang('lernen-nachfrage'), meter.costUsd(c));
  // Haiku: 400 Eingabe, 60 Ausgabe = 0.0004 + 0.0003
  assert.equal(inv.kostenJeVorgang('lernen-nachfrage'), 0.0007);
});

test('Text-Generator: Zwischenspeicher spart gegenüber ohne Zwischenspeicher, auch mit Schreibzuschlag', () => {
  const mit = inv.textGenZweiDurchgaenge({ cache: true }).reduce((s, c) => s + meter.costUsd(c), 0);
  const ohne = inv.textGenZweiDurchgaenge({ cache: false }).reduce((s, c) => s + meter.costUsd(c), 0);
  assert.ok(mit < ohne, `mit ${mit} ohne ${ohne}`);
  // Goldtexte (3000 Zeichen) und Stilkarte (400) erhöhen die Kosten nur wenig
  const gold = inv.textGenZweiDurchgaenge({ gold: inv.A.gold, stilkarte: inv.A.stilkarte }).reduce((s, c) => s + meter.costUsd(c), 0);
  assert.ok(gold > mit && gold - mit < 0.01);
});

test('Szenario: Summe stimmt, automatische Funktionen sind markiert', () => {
  const s = inv.szenario();
  const summe = s.rows.reduce((a, r) => a + r.jeMonat, 0);
  assert.ok(Math.abs(summe - s.total) < 1e-9);
  const auto = s.rows.filter(r => r.automatisch).map(r => r.key).sort();
  for (const k of ['waechter', 'comm-profile', 'themenplan', 'lernen-korrektur', 'lernen-nachfrage', 'lernen-daumen', 'schnelltest', 'feedback-vorschlag']) assert.ok(auto.includes(k), k + ' ohne Klick');
  assert.ok(!auto.includes('text-gen'));
  assert.ok(s.total > 0 && s.auto > 0 && s.auto < s.total);
  assert.equal(inv.info('waechter').automatisch, true);
  assert.equal(inv.info('sparring').automatisch, false);
});

test('Jeder Schlüssel für das Nutzungsprotokoll im Code steht im Inventar', () => {
  const dirs = ['routes', 'lib', 'jobs'].map(d => path.join(__dirname, '..', d));
  const found = new Set();
  for (const d of dirs) for (const f of fs.readdirSync(d).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(d, f), 'utf8');
    for (const m of src.matchAll(/meter:\s*\{[^}]*module:\s*'([a-z-]+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/,\s*'(lernen-daumen|router|health-score)'\);/g)) found.add(m[1]);
  }
  // Keine Funktion im Code, die im Protokoll unter einem Namen läuft, den das Inventar nicht kennt
  const bekannt = new Set([...Object.keys(inv.INVENTAR), 'text-gen']);
  const unbekannt = [...found].filter(k => !bekannt.has(k));
  assert.deepEqual(unbekannt, []);
  assert.ok(found.size >= 15, 'gefunden: ' + [...found].join(', '));
});
