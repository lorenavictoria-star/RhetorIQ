// Zwischenspeicher (Prompt-Caching): Reihenfolge der Systemblöcke, Markierungen, Wiederverwendung im zweiten Durchgang,
// kein doppelter Kontext. Prüft die Aufträge, die an die KI-Attrappe gehen (keine echten Aufrufe).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = require('../db');
const A = require('../routes/analyze')._internal;

const mk = (t) => ({ type: 'text', text: t });
const markIdx = (blocks) => blocks.map((b, i) => (b.cache_control ? i : -1)).filter(i => i >= 0);

test('assembleSystemBlocks: Reihenfolge stabil nach wechselnd, Markierungen nur vor dem Wechselnden', () => {
  const parts = {
    baseSystem: 'BASIS-MODULPROMPT', brandVoiceBlock: 'BRAND-VOICE-BLOCK', structuralRefBlock: 'REFERENZ-DOKUMENT',
    geoBlock: 'GEO-ZUSATZ',
    restDynamicSystem: 'CUSTOM INSTRUCTIONS Y GELERNTE PRÄFERENZEN Y VORBILD 1 STILKARTE Heute ist Freitag'
  };
  const einDurchgang = A.assembleSystemBlocks({ ...parts, tune: false });
  const texte = einDurchgang.map(b => b.text);
  assert.deepEqual(texte.slice(0, 5), ['BASIS-MODULPROMPT', 'BRAND-VOICE-BLOCK', 'REFERENZ-DOKUMENT', 'GEO-ZUSATZ', parts.restDynamicSystem]);
  assert.equal(texte[texte.length - 1], A.GLOBAL_STYLE_RULES, 'Regelwerk bleibt der letzte Block');
  const dyn = texte.indexOf(parts.restDynamicSystem);
  // ohne zweiten Durchgang: Markierungen nur auf den drei stabilen Blöcken, nichts ab dem wechselnden Teil
  assert.deepEqual(markIdx(einDurchgang), [0, 1, 2]);
  assert.ok(markIdx(einDurchgang).every(i => i < dyn));

  const zwei = A.assembleSystemBlocks({ ...parts, tune: true });
  const m = markIdx(zwei);
  assert.ok(m.length <= 3, 'höchstens drei Markierungen im System');
  assert.equal(m[m.length - 1], zwei.length - 1, 'die letzte Markierung schliesst das System ein (Durchgang 2 liest es)');
  assert.ok(m.slice(0, -1).every(i => i < dyn), 'alle früheren Markierungen stehen vor dem Wechselnden');
  assert.ok(m.length + 1 <= 4, 'zusammen mit dem Auftragsblock höchstens vier');
  // Ohne Brand Voice und Referenz bleibt die Reihenfolge, der Basisblock bleibt markiert
  const nur = A.assembleSystemBlocks({ baseSystem: 'B', restDynamicSystem: 'dyn', tune: true });
  assert.deepEqual(markIdx(nur).length <= 3, true);
  assert.equal(nur[0].cache_control.type, 'ephemeral');
  // Leeres System: Rückfallsatz, dann Datenregel und Regelwerk
  assert.equal(A.assembleSystemBlocks({ tune: false })[0].text, 'You are a helpful communication assistant.');
});

test('shouldTuneCache: nur wenn jemand das System erneut liest', () => {
  assert.equal(A.shouldTuneCache('text-gen', true, false, null), true, 'zweiter Durchgang');
  assert.equal(A.shouldTuneCache('text-gen', false, false, null), false, 'Haken «Gründlich prüfen» aus oder grosse Eingabe: kein Schreibzuschlag');
  assert.equal(A.shouldTuneCache('text-gen', false, false, { note: 'kürzer' }), true, 'Nachfrage liest das System kurz nach dem Text');
  assert.equal(A.shouldTuneCache('text-gen', true, true, null), false, 'Entwurf mit Haiku: anderes Modell, anderer Zwischenspeicher');
  assert.equal(A.shouldTuneCache('sparring', true, false, null), false, 'Einzelmodule haben keinen zweiten Durchgang');
});

let srv, c;
const BV = 'SENTINEL-BV-EINZIGARTIG Wir schreiben warm, direkt und mit kurzen Sätzen. ' + 'Brand-Voice-Text. '.repeat(40);
const REF = 'SENTINEL-REF-EINZIGARTIG Strukturvorlage mit drei Teilen. ';
test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  c = await H.addClient('Cachefirma AG');
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice',$2)`, [c.id, BV]);
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'structural_reference',$2)`, [c.id, REF]);
  await pool.query(`INSERT INTO client_module_prompts (client_id, module_key, instructions) VALUES ($1,'text-gen','SENTINEL-CUSTOM Immer mit Gruss enden.')`, [c.id]);
  await pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary) VALUES ($1,'text-gen','TON','SENTINEL-LERNEN Kürzere Sätze.')`, [c.id]);
  await pool.query(`INSERT INTO goldtexte (client_id, feedback_key, text) VALUES ($1,'text-gen','SENTINEL-GOLD ${'Ein finalisierter Beispieltext mit Substanz. '.repeat(8)}')`, [c.id]);
  srv = await H.startApp([['/api/analyze', require('../routes/analyze')]]);
});
test.after(async () => { await srv.close(); });

const zaehle = (haystack, needle) => haystack.split(needle).length - 1;
const alles = (call) => JSON.stringify(call.system) + JSON.stringify(call.messages);
const gen = (body) => srv.call('POST', '/api/analyze', { token: H.advisorToken(), body: { module: 'text-gen', clientId: c.id, data: { text: 'Einladung zum Sommerfest', tile: 'email' }, ...body } });

test('Text-Generator mit zwei Durchgängen: stabiler Teil vorn und markiert, Wechselndes dahinter, Durchgang 2 liest denselben Anfang', async () => {
  H.ai.calls.length = 0;
  H.ai.reply = (opts) => (JSON.stringify(opts.messages).includes('ENTWURF (erster Versuch)') ? 'Endtext.' : 'Entwurf: ' + 'x'.repeat(300));
  const r = await gen({});
  assert.equal(r.status, 200);
  assert.equal(H.ai.calls.length, 2, 'zwei Durchgänge');
  const [d1, d2] = H.ai.calls;
  const sys = d1.system;
  const idx = (s) => sys.findIndex(b => b.text.includes(s));
  // Reihenfolge: Modul-Prompt, Brand Voice, Referenz, wechselnder Teil, Regelwerk
  assert.equal(idx('SENTINEL-BV-EINZIGARTIG'), 1);
  assert.equal(idx('SENTINEL-REF-EINZIGARTIG'), 2);
  const dyn = idx('SENTINEL-CUSTOM');
  assert.ok(dyn > 2);
  for (const s of ['SENTINEL-LERNEN', 'SENTINEL-GOLD', 'Heute ist ']) assert.equal(idx(s), dyn, s + ' im wechselnden Block');
  assert.ok(!sys[dyn].cache_control, 'der wechselnde Block trägt selbst keine Markierung');
  assert.ok(sys.slice(0, 3).every(b => !b.text.includes('SENTINEL-GOLD') && !b.text.includes('Heute ist ') && !b.text.includes('SENTINEL-LERNEN')), 'nichts Wechselndes in den stabilen Blöcken');
  const m = markIdx(sys);
  assert.ok(m.length <= 3);
  assert.equal(m[m.length - 1], sys.length - 1);
  assert.ok(m.slice(0, -1).every(i => i < dyn), 'frühere Markierungen vor dem Wechselnden');
  assert.equal(sys[sys.length - 1].text, A.GLOBAL_STYLE_RULES);
  // Auftragsblock markiert, Gesamtzahl höchstens vier
  const u1 = d1.messages[0].content, u2 = d2.messages[0].content;
  assert.ok(Array.isArray(u1) && u1[0].cache_control);
  assert.ok(m.length + 1 <= 4);
  // Durchgang 2: identisches System und derselbe markierte Auftragsblock, dahinter Entwurf und Prüfanweisung
  assert.deepEqual(d2.system, d1.system);
  assert.equal(u2[0].text, u1[0].text);
  assert.ok(u2[0].cache_control);
  assert.match(u2[1].text, /ENTWURF \(erster Versuch\)/);
  // Kein doppelter Kontext: Brand Voice, Referenz, Goldtext und Kundenanweisung je einmal pro Aufruf
  for (const call of [d1, d2]) {
    const t = alles(call);
    for (const s of ['SENTINEL-BV-EINZIGARTIG', 'SENTINEL-REF-EINZIGARTIG', 'SENTINEL-CUSTOM', 'SENTINEL-GOLD', 'SENTINEL-LERNEN']) assert.equal(zaehle(t, s), 1, s);
  }
  // Grösse (Zeichen): Durchgang 2 = Durchgang 1 plus Entwurf und Prüfanweisung, das System ist gleich gross
  const len = (call) => ({ system: JSON.stringify(call.system).length, user: JSON.stringify(call.messages).length });
  assert.equal(len(d2).system, len(d1).system);
  assert.ok(len(d2).user > len(d1).user && len(d2).user < len(d1).user + 2000, 'Zusatz im zweiten Durchgang bleibt klein');
});

test('Ohne zweiten Durchgang (Haken aus): kein Schreibzuschlag am Ende des Systems, nur die stabilen Blöcke sind markiert', async () => {
  H.ai.calls.length = 0; H.ai.reply = 'Text.';
  const r = await gen({ thorough: false });
  assert.equal(r.status, 200);
  assert.equal(H.ai.calls.length, 1);
  const sys = H.ai.calls[0].system;
  assert.deepEqual(markIdx(sys), [0, 1, 2]);
  assert.equal(typeof H.ai.calls[0].messages[0].content, 'string');
});

test('Grosse Eingabe überspringt den zweiten Durchgang und damit auch die End-Markierung', async () => {
  H.ai.calls.length = 0; H.ai.reply = 'Text.';
  const r = await gen({ data: { text: 'Bitte überarbeiten. ' + 'Satz. '.repeat(900), tile: 'email' } });
  assert.equal(r.status, 200);
  assert.equal(H.ai.calls.length, 1);
  assert.deepEqual(markIdx(H.ai.calls[0].system), [0, 1, 2]);
});

test('Beide Routen bauen das System über assembleSystemBlocks', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/analyze'), 'utf8');
  assert.equal((src.match(/= assembleSystemBlocks\(/g) || []).length, 2);
  assert.equal((src.match(/tuneCache\(/g) || []).length, 2, 'Definition und ein Aufruf in assembleSystemBlocks');
});
