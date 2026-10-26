const test = require('node:test');
const assert = require('node:assert');
const { sitemapSeiten, seiteLesen, eigenerText } = require('../lib/seiteImport');

// Simulierter Abruf: Karte von Adresse zu Antwort, kein echtes Netz.
function fake(karte, aufrufe = []) {
  return async (u) => {
    const key = u.toString();
    aufrufe.push(key);
    if (!(key in karte)) return { status: 404, body: '' };
    const v = karte[key];
    return typeof v === 'string' ? { status: 200, body: v } : v;
  };
}
const urlset = (...pfade) => `<?xml version="1.0"?><urlset>${pfade.map(p => `<url><loc>${p}</loc></url>`).join('')}</urlset>`;

test('Sitemap-Index mit zwei Untersitemaps, Filter und Duplikate', async () => {
  const karte = {
    'https://beispiel.ch/robots.txt': 'User-agent: *\nSitemap: https://beispiel.ch/sitemap_index.xml\n',
    'https://beispiel.ch/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://beispiel.ch/page-sitemap.xml</loc></sitemap><sitemap><loc>https://beispiel.ch/de/page-sitemap.xml</loc></sitemap></sitemapindex>',
    'https://beispiel.ch/page-sitemap.xml': urlset('https://beispiel.ch/', 'https://beispiel.ch/ueber-uns/', 'https://beispiel.ch/portfolio-tag/x/', 'https://beispiel.ch/hello-world/', 'https://beispiel.ch/feed/', 'https://beispiel.ch/flyer.pdf', 'https://beispiel.ch/bild.jpg', 'https://fremd.com/seite/'),
    'https://beispiel.ch/de/page-sitemap.xml': urlset('https://beispiel.ch/de/kontakt/', 'https://beispiel.ch/ueber-uns', 'https://beispiel.ch/3d-flip-book/katalog/', 'https://beispiel.ch/wp-json/x')
  };
  const r = await sitemapSeiten('https://beispiel.ch', { fetchImpl: fake(karte) });
  assert.deepStrictEqual(r.map(s => s.pfad).sort(), ['/', '/de/kontakt', '/ueber-uns']);
  assert.ok(r.every(s => s.url.startsWith('https://beispiel.ch/')));
});

test('maxSeiten begrenzt die Liste', async () => {
  const karte = { 'https://beispiel.ch/sitemap.xml': urlset('https://beispiel.ch/a/', 'https://beispiel.ch/b/', 'https://beispiel.ch/c/') };
  const r = await sitemapSeiten('https://beispiel.ch', { fetchImpl: fake(karte), maxSeiten: 2 });
  assert.strictEqual(r.length, 2);
});

test('Fallback über Links der Startseite', async () => {
  const karte = {
    'https://beispiel.ch/': '<html><body><nav><a href="/angebot/">Angebot</a><a href="https://beispiel.ch/kontakt">Kontakt</a><a href="https://extern.de/x">E</a><a href="mailto:a@b.ch">M</a><a href="/angebot/#top">Dup</a><a href="/datei.pdf">P</a></nav></body></html>'
  };
  const r = await sitemapSeiten('https://beispiel.ch', { fetchImpl: fake(karte) });
  assert.deepStrictEqual(r.map(s => s.pfad).sort(), ['/', '/angebot', '/kontakt']);
});

test('Ohne Sitemap und ohne Startseite: Fehler mit Code', async () => {
  await assert.rejects(sitemapSeiten('https://beispiel.ch', { fetchImpl: fake({}) }), e => e.code === 'netz');
});

const HTML = `<!doctype html><html lang="de-CH"><head><title>Über uns &amp; mehr</title>
<meta name="description" content="Kurze Beschreibung"><style>.x{}</style><script>var a=1;</script></head>
<body><header><h1>Logo-Kopf</h1></header><nav><a href="/">Start</a> Menüpunkt</nav>
<main><h1>Unser Team</h1><p>Erster   Absatz mit   Text.</p><h2>Geschichte</h2><p>Zweiter Absatz.</p>
<img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" alt="Foto"><form><input> Formulartext</form><svg><text>SvgText</text></svg></main>
<footer>Impressum Footertext</footer></body></html>`;

test('Textextraktion ohne Navigation, Footer, Formular', async () => {
  const s = await seiteLesen('https://beispiel.ch/team', { fetchImpl: fake({ 'https://beispiel.ch/team': HTML }) });
  assert.strictEqual(s.titel, 'Über uns & mehr');
  assert.strictEqual(s.metaBeschreibung, 'Kurze Beschreibung');
  assert.deepStrictEqual(s.h1, ['Unser Team']);
  assert.deepStrictEqual(s.h2, ['Geschichte']);
  assert.strictEqual(s.sprache, 'de');
  assert.strictEqual(s.bilderOhneAlt, 2);
  assert.strictEqual(s.text, 'Unser Team\n\nErster Absatz mit Text.\n\nGeschichte\n\nZweiter Absatz.');
  assert.strictEqual(s.woerter, 9);
  for (const w of ['Menüpunkt', 'Footertext', 'Formulartext', 'SvgText', 'var a']) assert.ok(!s.text.includes(w), w);
});

test('Ohne main-Element wird der Body ohne nav und footer genommen', async () => {
  const h = '<html><body><nav>Menü</nav><div><p>Inhalt hier</p></div><footer>Fuss</footer></body></html>';
  const s = await seiteLesen('https://beispiel.ch/', { fetchImpl: fake({ 'https://beispiel.ch/': h }) });
  assert.strictEqual(s.text, 'Inhalt hier');
});

test('eigenerText schätzt mit Vorlagenwörtern', () => {
  assert.deepStrictEqual(eigenerText({ woerter: 400 }), { woerter: 160, vermutlichTextseite: true });
  assert.deepStrictEqual(eigenerText({ woerter: 300 }), { woerter: 60, vermutlichTextseite: false });
  assert.deepStrictEqual(eigenerText({ woerter: 100 }), { woerter: 0, vermutlichTextseite: false });
  assert.strictEqual(eigenerText({ woerter: 400 }, 300).woerter, 100);
});

test('Private und ungültige Adressen werden abgelehnt, ohne Abruf', async () => {
  const aufrufe = [];
  const f = fake({}, aufrufe);
  for (const u of ['http://127.0.0.1/', 'http://10.1.2.3/x', 'http://localhost/', 'http://[::1]/', 'http://192.168.0.5/']) {
    await assert.rejects(seiteLesen(u, { fetchImpl: f }), e => e.code === 'verboten', u);
    await assert.rejects(sitemapSeiten(u, { fetchImpl: f }), e => e.code === 'verboten', u);
  }
  await assert.rejects(seiteLesen('file:///etc/passwd', { fetchImpl: f }), e => e.code === 'ungueltig');
  await assert.rejects(seiteLesen('', { fetchImpl: f }), e => e.code === 'ungueltig');
  assert.strictEqual(aufrufe.length, 0);
});

test('Weiterleitung auf eine private Adresse wird abgelehnt', async () => {
  const karte = { 'https://beispiel.ch/a': { status: 302, location: 'http://127.0.0.1/geheim', body: '' } };
  await assert.rejects(seiteLesen('https://beispiel.ch/a', { fetchImpl: fake(karte) }), e => e.code === 'verboten');
});

test('Höchstens 3 Weiterleitungen', async () => {
  const karte = {};
  for (let i = 0; i < 6; i++) karte[`https://beispiel.ch/r${i}`] = { status: 301, location: `/r${i + 1}`, body: '' };
  await assert.rejects(seiteLesen('https://beispiel.ch/r0', { fetchImpl: fake(karte) }), e => e.code === 'netz' && /Weiterleitung/.test(e.message));
  karte['https://beispiel.ch/r3'] = '<html><body><p>Ziel</p></body></html>';
  const s = await seiteLesen('https://beispiel.ch/r0', { fetchImpl: fake(karte) });
  assert.strictEqual(s.text, 'Ziel');
});

test('Limits: zu gross, Zeit, Netzfehler, Status', async () => {
  const gross = 'x'.repeat(2 * 1024 * 1024 + 10);
  await assert.rejects(seiteLesen('https://beispiel.ch/g', { fetchImpl: fake({ 'https://beispiel.ch/g': gross }) }), e => e.code === 'gross');
  const zeit = async () => { const e = new Error('t'); e.code = 'zeit'; throw e; };
  await assert.rejects(seiteLesen('https://beispiel.ch/', { fetchImpl: zeit }), e => e.code === 'zeit');
  const netz = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(seiteLesen('https://beispiel.ch/', { fetchImpl: netz }), e => e.code === 'netz');
  await assert.rejects(seiteLesen('https://beispiel.ch/fehlt', { fetchImpl: fake({}) }), e => e.code === 'netz' && /404/.test(e.message));
});
