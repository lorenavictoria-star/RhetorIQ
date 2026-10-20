// Sicherheitsseite: Routen, Navigation, Fuss, Aussagen, Schreibregeln und Eingebundenheit (CSP-Muster wie die übrigen Landingseiten).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', '..', 'public');
const lies = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const sichtbar = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

test('Sicherheit: Routen und hreflang-Paar', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(index.includes("app.get('/sicherheit'") && index.includes("'sicherheit.html'"));
  assert.ok(index.includes("app.get('/en/security'") && index.includes("'sicherheit.en.html'"));
  const sitemap = lies('sitemap.xml');
  for (const f of ['sicherheit.html', 'sicherheit.en.html']) {
    const h = lies(f);
    assert.ok(h.includes('<link rel="alternate" hreflang="de" href="https://rhetoriq.ch/sicherheit">'));
    assert.ok(h.includes('<link rel="alternate" hreflang="en" href="https://rhetoriq.ch/en/security">'));
  }
  assert.ok(sitemap.includes('hreflang="en" href="https://rhetoriq.ch/en/security"'));
});

test('Sicherheit: Navigation und Fuss der Landingseiten verlinken die Seite', () => {
  for (const f of ['landing.html', 'landing.preise.html']) {
    const h = lies(f);
    assert.ok(h.includes('<a href="/sicherheit">Sicherheit</a>'), 'Navigation ' + f);
    assert.ok(/<footer>[\s\S]*href="\/sicherheit"/.test(h), 'Fuss ' + f);
  }
  for (const f of ['landing.en.html', 'landing.preise.en.html']) {
    const h = lies(f);
    assert.ok(h.includes('<a href="/en/security">Security</a>'), 'Navigation ' + f);
    assert.ok(/<footer>[\s\S]*href="\/en\/security"/.test(h), 'Fuss ' + f);
  }
  for (const [f, self] of [['sicherheit.html', '/sicherheit'], ['sicherheit.en.html', '/en/security']]) {
    const h = lies(f);
    assert.ok(h.includes(`<a href="${self}" aria-current="page">`), 'aktuelle Seite markiert ' + f);
    assert.ok(/<footer>[\s\S]*href="\/\?p=datenschutz"/.test(h), 'Fuss mit Datenschutz ' + f);
  }
});

test('Sicherheit: Inhalt, Stufen, Ampel, FAQ, Datenfluss, Link zum Termin', () => {
  const de = lies('sicherheit.html');
  assert.ok(de.includes('<h1>Ihre Daten bleiben Ihre.</h1>'));
  assert.ok(de.includes('Verfügbar') && de.includes('Auf Anfrage') && de.includes('In Arbeit'));
  assert.ok(de.includes('Stufe 1') && de.includes('Stufe 2') && de.includes('Stufe 3'));
  for (const w of ['Grün', 'Gelb', 'Rot']) assert.ok(de.includes(`<p class="fb">${w}</p>`), w);
  assert.strictEqual((de.match(/<details class="prd">/g) || []).length, 9, 'neun Fragen');
  assert.ok(de.includes('<svg viewBox') && de.includes('<title id="fltt">') && de.includes('role="img"'));
  assert.ok(de.includes('href="/termin"') && de.includes('Auftragsbearbeitungsvertrag'));
  for (const a of ['Render', 'Anthropic', 'Brevo', 'AssemblyAI', 'Stripe', 'Sentry']) assert.ok(de.includes(`<b>${a}</b>`), a);
  assert.ok(!/garantiert|100 ?Prozent|100 ?%/i.test(sichtbar(de)), 'keine Übertreibung');
  const en = lies('sicherheit.en.html');
  assert.ok(en.includes('<h1>Your data stays yours.</h1>') && en.includes('Available') && en.includes('On request') && en.includes('In progress'));
  assert.strictEqual((en.match(/<details class="prd">/g) || []).length, 9);
  assert.ok(en.includes('href="/termin"'));
});

test('Sicherheit: Schreibregeln, keine Kursivschrift, keine Fremdskripte', () => {
  for (const f of ['sicherheit.html', 'sicherheit.en.html']) {
    const h = lies(f);
    const t = sichtbar(h);
    assert.ok(!/[–—]/.test(t), 'keine Gedankenstriche ' + f);
    assert.ok(!t.includes('ß'), 'kein ß ' + f);
    assert.ok(!/\bnicht\b[^.]{0,60}\bsondern\b/i.test(t) && !/\bnot\b[^.]{0,40}\bbut\b/i.test(t), 'keine Gegenüberstellung ' + f);
    assert.ok(!/nicht nur/i.test(t) && !/not only|not just/i.test(t), 'kein nicht nur ' + f);
    assert.ok(!/, nicht\b/.test(t), 'kein «X, nicht Y» ' + f);
    assert.ok(!/<em[ >]|font-style:\s*italic/.test(h), 'keine Kursivschrift ' + f);
    assert.ok(!/<script[^>]+src=/.test(h), 'keine externen Skripte ' + f);
    assert.ok(!/\son[a-z]+=/.test(h), 'keine Inline-Handler ' + f);
  }
});
