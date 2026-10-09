// Gedächtnis nach Relevanz (Aufgabe 6): Reihenfolge, Gewichte, Füllen bis zur Grenze, Liste der weggelassenen Einträge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const M = require('../lib/memorySelect');

const e = (type, content) => ({ memory_type: type, content });
const typen = (r) => r.selected.map(s => s.type);

test('brand_voice kommt zuerst und vollständig, auch über der Kappung eines Einzeldokuments', () => {
  const lang = 'x'.repeat(30000);
  const r = M.select([e('key_facts', 'Fakten'), e('brand_voice', lang), e('brand_voice_ind_anna', 'Anna spricht kurz')], { briefing: '' });
  assert.deepEqual(typen(r).slice(0, 2).sort(), ['brand_voice', 'brand_voice_ind_anna']);
  assert.equal(r.selected.find(s => s.type === 'brand_voice').content.length, 30000, 'nicht gekürzt');
});

test('ref_tg der gewählten Textart vor allgemeinen Referenzen, andere Textarten gehören nicht dazu', () => {
  const r = M.select([e('culture_notes', 'Kultur'), e('ref_tg_linkedin', 'LinkedIn Beispiele'), e('ref_tg_email', 'Mail Beispiele'), e('key_facts', 'Fakten')], { tile: 'email', briefing: '' });
  assert.equal(typen(r)[0], 'ref_tg_email');
  assert.ok(!typen(r).includes('ref_tg_linkedin'));
  assert.equal(r.omitted.length, 0, 'eine fremde Textart zählt nicht als weggelassen wegen Länge');
});

test('key_facts vor ref_brand_voice_source, auch wenn die Quelle zum Briefing passt', () => {
  const r = M.select([
    e('ref_brand_voice_source', 'Preisanpassung Kundschaft Offerte Preisanpassung'),
    e('key_facts', 'Gründung 1990, Sitz Winterthur')
  ], { briefing: 'Preisanpassung für die Kundschaft' });
  assert.deepEqual(typen(r), ['key_facts', 'ref_brand_voice_source']);
});

test('Wortüberlappung ordnet allgemeine Einträge nach Relevanz zum Briefing', () => {
  const r = M.select([
    e('culture_notes', 'Wir feiern gern Feste und pflegen den Teamgeist im Büro'),
    e('rhetoric_summary', 'Bei Preisverhandlungen argumentiert die Geschäftsleitung mit Qualität, Lieferzeit und Preisstabilität')
  ], { briefing: 'Preisverhandlung mit Lieferzeit und Qualität' });
  assert.equal(typen(r)[0], 'rhetoric_summary');
  const r2 = M.select([e('culture_notes', 'Teamgeist'), e('rhetoric_summary', 'Preis')], { briefing: 'Teamgeist im Büro' });
  assert.equal(typen(r2)[0], 'culture_notes');
});

test('Füllen bis 40000 Zeichen: Was nicht passt, steht mit Grund in der Liste der weggelassenen', () => {
  const r = M.select([
    e('key_facts', 'a'.repeat(15000)),
    e('culture_notes', 'b'.repeat(15000)),
    e('rhetoric_summary', 'c'.repeat(15000)),
    e('ref_brand_voice_source', 'd'.repeat(9000))
  ], { briefing: '' });
  assert.ok(r.chars <= 40000);
  assert.deepEqual(typen(r), ['key_facts', 'culture_notes', 'ref_brand_voice_source']);
  assert.deepEqual(r.omitted, [{ type: 'rhetoric_summary', chars: 15000, grund: 'Länge' }]);
  // Der Quelltext wird auf 8000 Zeichen gekürzt und gilt dann als gekürzt, nicht als weggelassen
  const klein = M.select([e('ref_brand_voice_source', 'd'.repeat(9000))], {});
  assert.deepEqual(klein.gekuerzt, ['ref_brand_voice_source']);
  assert.equal(klein.omitted.length, 0);
});

test('Ein kleinerer Eintrag weiter hinten wird nachgeladen, wenn ein grosser nicht mehr passt', () => {
  const r = M.select([e('key_facts', 'a'.repeat(15000)), e('culture_notes', 'b'.repeat(15000)), e('rhetoric_summary', 'c'.repeat(15000)), e('ref_brand_voice_source', 'kurz')], {});
  assert.ok(typen(r).includes('ref_brand_voice_source'));
  assert.equal(r.omitted.length, 1);
});

test('Struktur-Referenz und leere Einträge bleiben draussen, die Anbindung im Browser ist vorhanden', () => {
  const r = M.select([e('structural_reference', 'Struktur'), e('key_facts', ''), e('key_facts2', 'ok')], {});
  assert.deepEqual(typen(r), ['key_facts2']);
  const html = fs.readFileSync(require.resolve('../../public/index.html'), 'utf8');
  assert.ok(html.includes('src="/memorySelect.js"'));
  assert.ok(html.includes('<script id="rq-mem-js">'));
});
