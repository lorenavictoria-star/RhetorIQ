const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'wissen');
const SEITEN = ['index', 'reden-schreiben-lassen', 'rhetorik-coaching-fuehrungspersonen', 'unternehmenssprache', 'ki-texte-in-ihrer-stimme'];
function sichtbar(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}
test('wissen.lorenalienhard.ch: Seiten, Canonical, Sitemap, Schreibregeln, Host-Weiche', () => {
  const sitemap = fs.readFileSync(path.join(DIR, 'sitemap.xml'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(index, /wissen\\\.lorenalienhard\\\.ch/);
  for (const s of SEITEN) {
    const html = fs.readFileSync(path.join(DIR, s + '.html'), 'utf8');
    const url = 'https://wissen.lorenalienhard.ch' + (s === 'index' ? '/' : '/' + s);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), s);
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), s);
    assert.ok(html.includes('https://rhetoriq.ch/termin'), s);
    const t = sichtbar(html);
    assert.ok(!t.includes('—'), s + ' Gedankenstrich');
    assert.ok(!/\bß/.test(t), s + ' scharfes s');
    assert.ok(!/<(i|em)[ >]/.test(html), s + ' kursiv');
  }
});
