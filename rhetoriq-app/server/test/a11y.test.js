// Barrierefreiheit: Prüfskript für public/index.html (liest die Datei als Text).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function rootVars() {
  const m = html.match(/:root\{([\s\S]*?)\n\}/);
  assert.ok(m, ':root-Block fehlt');
  const v = {};
  for (const x of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) v[x[1]] = x[2].toUpperCase();
  return v;
}

test('Kontrast: Textfarben erreichen AA (4.5 zu 1) auf ihren Hintergründen', () => {
  const v = rootVars();
  const grounds = { bg: v.bg, acl: v['acl'] };
  for (const [name, g] of Object.entries(grounds)) {
    for (const t of ['tx', 'mu', 'dm', 'ac', 'red']) {
      const r = ratio(v[t], g);
      assert.ok(r >= 4.5, `--${t} auf --${name} hat nur ${r.toFixed(2)}`);
    }
  }
  assert.ok(ratio('#FFFFFF', v.ac) >= 4.5, 'Weisse Schrift auf Gold verfehlt AA');
  for (const t of ['rail-tx', 'rail-mu', 'rail-ac']) {
    const r = ratio(v[t], v.rail);
    assert.ok(r >= 4.5, `--${t} auf --rail hat nur ${r.toFixed(2)}`);
  }
});

test('Struktur: genau ein main, Navigation, Ansageregion', () => {
  assert.strictEqual((html.match(/setAttribute\('role','main'\)/g) || []).length + (html.match(/<main[\s>]/g) || []).length, 1);
  assert.ok(/aria-live/.test(html), 'aria-live fehlt');
  assert.ok(/setAttribute\('role','navigation'\)/.test(html), 'role=navigation fehlt');
  assert.ok(/class="rq-skip"|className='rq-skip'/.test(html), 'Sprunglink fehlt');
  assert.ok(/<html lang="de">/.test(html) && /documentElement\.lang\s*=\s*LANG/.test(html), 'lang wird nicht geführt');
});

test('Dialoge: role=dialog, aria-modal und Escape', () => {
  assert.ok(/setAttribute\('role','dialog'\)/.test(html));
  assert.ok(/setAttribute\('aria-modal','true'\)/.test(html));
  assert.ok(/aria-labelledby/.test(html));
  assert.ok(/e\.key==='Escape'/.test(html));
  assert.ok(/querySelectorAll\('\.ov,#rq-wiz'\)/.test(html), 'Modale .ov und #rq-wiz müssen erfasst sein');
});

test('Fokus: kein outline:none ohne sichtbaren Ersatz', () => {
  assert.ok(/:focus-visible\{outline:2px solid var\(--ac\)!important/.test(html), 'globaler Fokusring fehlt');
  assert.ok(/input:focus-visible,select:focus-visible,textarea:focus-visible/.test(html), 'Fokusring für Eingaben fehlt');
  // Jeder outline:none im Stylesheet braucht den globalen !important-Ring als Ersatz (Ausnahme: Containerfokus).
  const css = (html.match(/<style[\s\S]*?<\/style>/g) || []).join('\n');
  const none = (css.match(/outline:\s*none/g) || []).length;
  assert.ok(none >= 0);
  assert.ok(/:focus-visible\{outline:2px solid var\(--ac\)!important/.test(css));
  assert.ok(!/:focus-visible\{[^}]*outline:\s*none(?!\s*!important)/.test(css.replace(/#rq-main:focus[^}]*\}|\[role=dialog\]:focus[^}]*\}/g, '')), 'Fokusregel mit outline:none');
});

test('Bewegung und Zielgrösse', () => {
  assert.ok(/prefers-reduced-motion:reduce/.test(html));
  assert.ok(/min-height:44px!important/.test(html), '44-Pixel-Regel für Handy fehlt');
});

test('Rollen: Elemente mit onclick bekommen Tastaturzugang', () => {
  assert.ok(/setAttribute\('tabindex','0'\)/.test(html));
  assert.ok(/e\.key==='Enter'\|\|e\.key===' '/.test(html));
});
