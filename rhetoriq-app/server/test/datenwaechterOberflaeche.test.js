// Oberfläche des Daten-Wächters: Skriptblock, DE/EN-Paare, Schreibregeln, Verhalten der Einhängung (ohne Browser, mit Attrappen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const block = (id) => { const m = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html); assert.ok(m, 'Block fehlt: ' + id); return m[1]; };
const js = block('rq-datenwaechter-js');

test('Blöcke sind gültig und stehen in der richtigen Reihenfolge', () => {
  assert.doesNotThrow(() => new vm.Script(js));
  assert.doesNotThrow(() => new vm.Script(block('rq-xpairs-datenwaechter')));
  assert.ok(html.indexOf('<script id="rq-datenwaechter-js">') < html.indexOf('<script id="rq-lernkurve-js">'));
  assert.ok(html.indexOf('<script id="rq-xpairs-datenwaechter">') < html.indexOf('<script id="rq-i18n">'));
});

test('Texte aus Daten nur mit textContent, kein innerHTML im Block', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js));
  assert.ok(js.includes("k==='text')e.textContent"));
});

test('Schreibregeln: keine Gedankenstriche, kein ß, keine Kursivschrift, keine Negations-Konstruktionen', () => {
  const sichtbar = js + block('rq-xpairs-datenwaechter');
  assert.ok(!/[–—]/.test(sichtbar), 'Gedankenstrich');
  assert.ok(!/ß/.test(sichtbar), 'ß');
  assert.ok(!/<i>|<em>|font-style:\s*italic/.test(sichtbar), 'Kursivschrift');
  assert.ok(!/nicht nur|, nicht |, sondern|sondern /i.test(sichtbar), 'Negations-Konstruktion');
});

test('DE/EN-Paare: jedes Paar hat zwei Texte und alle festen Texte der Oberfläche sind erfasst', () => {
  const w = { RQ_EXTRA_PAIRS: [] };
  vm.runInNewContext(block('rq-xpairs-datenwaechter'), { window: w });
  assert.ok(w.RQ_EXTRA_PAIRS.length > 30);
  for (const p of w.RQ_EXTRA_PAIRS) assert.ok(typeof p[0] === 'string' && typeof p[1] === 'string' && p[0] && p[1]);
  const de = new Set(w.RQ_EXTRA_PAIRS.map(p => p[0]));
  for (const t of ['Daten-Wächter', 'Trotzdem senden', 'Ersetzen und senden', 'Abbrechen', 'Verstanden', 'Sensible Angaben im Text', 'Der Text wird nicht gesendet', 'Funde der letzten 30 Tage', 'Noch keine Funde.']) assert.ok(de.has(t), 'Paar fehlt: ' + t);
});

test('Dialog ist barrierefrei und responsiv, Farben kommen aus den CSS-Variablen', () => {
  assert.ok(js.includes("role:'alertdialog'") && js.includes("'aria-modal':'true'") && js.includes("'aria-labelledby':'rq-dw-t'") && js.includes("'aria-describedby':'rq-dw-d'"));
  assert.ok(js.includes("e.key==='Escape'") && js.includes("e.key==='Tab'"), 'Escape und Fokusführung');
  assert.ok(js.includes('@media (max-width:480px)') && js.includes('min-height:44px'));
  assert.ok(js.includes("'aria-live':'polite'"));
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(js.replace(/#1f6b45|#a8392c/g, '')), 'feste Farben');
});

// ── Verhalten mit Attrappen ──
function umgebung({ modus, funde, dialogAntwort, ausfall }) {
  const log = { aufrufe: [], gen: [], toasts: [], dialoge: [], fetch: [] };
  const ctx = {
    console, Promise, JSON, Object, Array, String, Date, Math, setTimeout, token: 'x', isAdv: false,
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }), head: { appendChild() {} }, body: { appendChild() {} } }
  };
  ctx.window = ctx;
  ctx.api = async (p, o) => { log.aufrufe.push([p, o]); if (ausfall && p === '/api/datenwaechter/pruefen') throw new Error('Netz weg'); return { ok: true, json: async () => (p === '/api/datenwaechter/pruefen' ? { modus, funde: /CH93/.test(JSON.parse(o.body).text) ? funde : [] } : {}) }; };
  ctx.generateAndStream = async (...a) => { log.gen.push(a); await ctx.fetch('https://x/api/analyze/stream', { method: 'POST', headers: { A: '1' }, body: '{}' }); };
  ctx.fetch = async (u, o) => { log.fetch.push([u, o]); return { ok: true }; };
  ctx.rqToast = (m) => log.toasts.push(m);
  ctx.wsRenderAdmin = () => {};
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  ctx.rqDatenwaechter.dialog = async (d) => { log.dialoge.push(d); return dialogAntwort; };
  return { ctx, log };
}
const IBAN_FUND = [{ typ: 'IBAN', label: 'IBAN', schwere: 'hoch', anzahl: 1, vorschau: 'CH93 •••• ••••' }];
const kopf = (log) => log.fetch.filter(f => /analyze/.test(f[0])).map(f => f[1].headers['X-Daten-Waechter']);
const TEXT = 'Bitte auf Konto CH93 0076 2011 6238 5295 7 zahlen.';

test('Texte ohne Funde: kein Dialog, Aufruf und Kopfzeilen unverändert', async () => {
  const { ctx, log } = umgebung({ modus: 'warnen', funde: [] });
  await ctx.generateAndStream('text-gen', { text: 'Ein ganz normaler Text.', voiceProfile: 'Stil' }, 'r', 'b');
  assert.equal(log.gen.length, 1);
  assert.equal(log.dialoge.length, 0);
  assert.deepEqual(kopf(log), [undefined]);
  assert.equal(log.fetch[0][1].headers.A, '1');
});

test('Das Stilprofil geht nicht in die Prüfung, die Eingabe schon', async () => {
  const { ctx, log } = umgebung({ modus: 'warnen', funde: [] });
  await ctx.generateAndStream('text-gen', { text: 'Konto CH93 0076 2011 6238 5295 7', voiceProfile: 'info@firma.ch' }, 'r', 'b');
  const gesendet = JSON.parse(log.aufrufe.find(a => a[0] === '/api/datenwaechter/pruefen')[1].body).text;
  assert.ok(gesendet.includes('CH93') && !gesendet.includes('info@firma.ch'));
});

test('warnen: «Ersetzen und senden» schickt die Kopfzeile genau einmal mit', async () => {
  const { ctx, log } = umgebung({ modus: 'warnen', funde: IBAN_FUND, dialogAntwort: 'ersetzen' });
  await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
  assert.equal(log.dialoge.length, 1);
  assert.deepEqual(kopf(log), ['ersetzen']);
  await ctx.generateAndStream('text-gen', { text: 'Anderer Text ohne Besonderheiten.' }, 'r', 'b');
  assert.equal(kopf(log)[1], undefined, 'die Kopfzeile gilt nur für den einen Aufruf');
});

test('warnen: «Trotzdem senden» sendet unverändert und fragt für denselben Text nicht noch einmal', async () => {
  const { ctx, log } = umgebung({ modus: 'warnen', funde: IBAN_FUND, dialogAntwort: 'senden' });
  await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
  await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
  assert.equal(log.gen.length, 2);
  assert.equal(log.dialoge.length, 1);
  assert.deepEqual(kopf(log), [undefined, undefined]);
});

test('Abbrechen im Modus warnen und der Hinweis im Modus sperren senden nichts', async () => {
  for (const modus of ['warnen', 'sperren']) {
    const { ctx, log } = umgebung({ modus, funde: IBAN_FUND, dialogAntwort: 'abbruch' });
    await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
    assert.equal(log.gen.length, 0, modus);
    assert.equal(log.fetch.length, 0);
    assert.equal(log.dialoge.length, 1);
  }
});

test('ersetzen: automatisch mit kurzer Info, ohne Dialog; der Server ersetzt', async () => {
  const { ctx, log } = umgebung({ modus: 'ersetzen', funde: IBAN_FUND });
  await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
  assert.equal(log.dialoge.length, 0);
  assert.equal(log.toasts.length, 1);
  assert.equal(log.gen.length, 1);
});

test('api(): /api/analyze wird geprüft, andere Pfade laufen unverändert durch', async () => {
  const { ctx, log } = umgebung({ modus: 'sperren', funde: IBAN_FUND, dialogAntwort: 'abbruch' });
  await assert.rejects(ctx.api('/api/analyze', { method: 'POST', body: JSON.stringify({ module: 'x', data: { text: TEXT } }) }), /nicht gesendet/);
  const n = log.aufrufe.length;
  await ctx.api('/api/clients', { method: 'GET' });
  assert.equal(log.aufrufe.length, n + 1);
});

test('Fällt die Prüfung aus, wird trotzdem gesendet (der Server entscheidet)', async () => {
  const { ctx, log } = umgebung({ modus: 'sperren', funde: IBAN_FUND, dialogAntwort: 'abbruch', ausfall: true });
  await ctx.generateAndStream('text-gen', { text: TEXT }, 'r', 'b');
  assert.equal(log.gen.length, 1);
  assert.equal(log.dialoge.length, 0);
});

test('Router ist in index.js eingehängt', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(idx.includes("app.use('/api/datenwaechter', require('./routes/datenwaechter'))"));
});
