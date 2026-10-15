const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', '..', 'public');
const SEITEN = [
  ['landing.kundenmail.html', '/kundenmails-mit-ki'],
  ['landing.stimme.html', '/firmenstimme'],
  ['landing.menschlicher.html', '/ki-texte-menschlicher'],
  ['landing.stimmaudit.html', '/stimm-audit'],
  ['landing.reden.html', '/reden-und-vortraege-mit-ki'],
];
function sichtbar(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}
test('Inhaltsseiten: Adresse, Canonical, Sitemap, Buchungsfenster, Schreibregeln', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sitemap = fs.readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8');
  for (const [datei, url] of SEITEN) {
    const html = fs.readFileSync(path.join(PUB, datei), 'utf8');
    assert.ok(index.includes(`app.get('${url}'`), 'Route ' + url);
    assert.ok(html.includes(`<link rel="canonical" href="https://rhetoriq.ch${url}">`), 'canonical ' + url);
    assert.ok(sitemap.includes(`<loc>https://rhetoriq.ch${url}</loc>`), 'sitemap ' + url);
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'ein H1 ' + url);
    assert.ok(html.includes('id="go"') && html.includes('id="rqd"'), 'Buchungsfenster ' + url);
    const t = sichtbar(html);
    assert.ok(!/[–—]/.test(t), 'keine Gedankenstriche ' + url);
    assert.ok(!t.includes('ß'), 'kein ß ' + url);
    assert.ok(!/\bnicht\b[^.]{0,60}\bsondern\b/i.test(t), 'keine Gegenüberstellung ' + url);
  }
});
