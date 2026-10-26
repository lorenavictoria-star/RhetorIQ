const http = require('http');
const https = require('https');
const { parseTarget, guardedLookup } = require('./safeFetch');

// Bestehende Webseite einlesen: Seitenliste aus der Sitemap und Text einer einzelnen Seite.
// Der Schutz gegen Zugriffe auf interne Adressen kommt aus lib/safeFetch (parseTarget prüft Schema,
// Port und Hostname, guardedLookup prüft jede aufgelöste IP im Socket selbst).
// safeFetchHtml wird nicht direkt genutzt, weil es bei Überschreitung des Limits abschneidet statt
// abzulehnen und nur 10 Sekunden erlaubt. Die Anfrage selbst steht darum hier.

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_HOPS = 3;

function fehler(code, meldung) {
  const e = new Error(meldung);
  e.code = code;
  return e;
}

// Standard-Abruf: eine einzelne Anfrage ohne automatische Weiterleitung.
// Rückgabe: { status, location, body }
function standardFetch(u, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RhetorIQ/1.0)', 'Accept': 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain', 'Accept-Encoding': 'identity' },
      timeout: timeoutMs
    }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location, body: '' });
      }
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) { req.destroy(fehler('gross', 'Die Seite ist grösser als 2 MB und wird nicht gelesen.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fehler('zeit', 'Die Webseite hat nicht innerhalb von 20 Sekunden geantwortet.')));
    req.on('error', reject);
    req.end();
  });
}

// Lädt eine Adresse, prüft jede Station einer Weiterleitung und liefert { url, status, body }.
async function laden(eingabe, fetchImpl) {
  let u;
  try { u = parseTarget(eingabe); } catch (e) {
    const verboten = /nicht erlaubt/.test(e.message);
    throw fehler(verboten ? 'verboten' : 'ungueltig', verboten ? 'Diese Adresse darf nicht abgerufen werden.' : e.message);
  }
  const impl = fetchImpl || standardFetch;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let r;
    try {
      r = await impl(u, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    } catch (e) {
      if (e && ['gross', 'zeit', 'verboten'].includes(e.code)) throw e;
      if (e && /nicht erlaubt/.test(e.message || '')) throw fehler('verboten', 'Diese Adresse darf nicht abgerufen werden.');
      if (e && (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT')) throw fehler('zeit', 'Die Webseite hat nicht innerhalb von 20 Sekunden geantwortet.');
      throw fehler('netz', 'Die Webseite konnte nicht erreicht werden.');
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      try { u = parseTarget(new URL(r.location, u).toString()); } catch (e) {
        throw fehler('verboten', 'Die Weiterleitung führt zu einer Adresse, die nicht abgerufen werden darf.');
      }
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw fehler('netz', `Die Webseite antwortet mit Status ${r.status}.`);
    const body = String(r.body || '');
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw fehler('gross', 'Die Seite ist grösser als 2 MB und wird nicht gelesen.');
    return { url: u.toString(), status: r.status, body };
  }
  throw fehler('netz', 'Die Webseite leitet zu oft weiter (mehr als 3 Weiterleitungen).');
}

// ---------- Sitemap ----------

const UNERWUENSCHT = /(portfolio-tag|3d-flip-book|hello-world|\/feed(\/|$)|wp-json|\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|xml)$)/i;

function hostOhneWww(h) { return String(h).toLowerCase().replace(/^www\./, ''); }

function locs(xml) {
  const out = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

function normalisieren(href, basis) {
  let u;
  try { u = new URL(href, basis); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (hostOhneWww(u.hostname) !== hostOhneWww(basis.hostname)) return null;
  u.hash = '';
  u.search = '';
  if (UNERWUENSCHT.test(u.pathname)) return null;
  let pfad = u.pathname.replace(/\/{2,}/g, '/');
  if (pfad.length > 1) pfad = pfad.replace(/\/$/, '');
  return { url: u.origin + (pfad === '/' ? '/' : pfad + '/'), pfad };
}

async function sitemapSeiten(baseUrl, { fetchImpl, maxSeiten = 300 } = {}) {
  let basis;
  try {
    const t = parseTarget(baseUrl);
    basis = new URL(t.origin);
  } catch (e) {
    const verboten = /nicht erlaubt/.test(e.message);
    throw fehler(verboten ? 'verboten' : 'ungueltig', verboten ? 'Diese Adresse darf nicht abgerufen werden.' : e.message);
  }
  const sicher = async (pfad) => {
    try { return (await laden(basis.origin + pfad, fetchImpl)).body; } catch (e) {
      if (e.code === 'verboten') throw e;
      return null;
    }
  };

  // Kandidaten: Sitemaps aus robots.txt, danach die üblichen Pfade
  const kandidaten = [];
  const robots = await sicher('/robots.txt');
  if (robots) {
    for (const z of robots.split(/\r?\n/)) {
      const m = z.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) kandidaten.push(m[1]);
    }
  }
  for (const p of ['/sitemap_index.xml', '/sitemap.xml', '/de/sitemap_index.xml']) kandidaten.push(basis.origin + p);

  const gesehenSitemaps = new Set();
  const seiten = new Map();

  async function lesen(adresse, tiefe) {
    if (tiefe > 3 || gesehenSitemaps.has(adresse) || gesehenSitemaps.size > 50) return;
    gesehenSitemaps.add(adresse);
    let xml;
    try { xml = (await laden(adresse, fetchImpl)).body; } catch (e) {
      if (e.code === 'verboten') return;
      return;
    }
    if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) return;
    const eintraege = locs(xml);
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const e of eintraege) {
        // Untersitemaps enden auf .xml und werden vom Dateifilter bewusst nicht als Seite gezählt
        let u; try { u = new URL(e, basis); } catch { continue; }
        if (hostOhneWww(u.hostname) !== hostOhneWww(basis.hostname)) continue;
        await lesen(u.toString(), tiefe + 1);
      }
      return;
    }
    for (const e of eintraege) {
      const n = normalisieren(e, basis);
      if (n && !seiten.has(n.url)) seiten.set(n.url, n);
    }
  }

  for (const k of kandidaten) {
    await lesen(k, 0);
    if (seiten.size) break;
  }

  // Fallback: interne Links der Startseite
  if (!seiten.size) {
    let html = null;
    try { html = (await laden(basis.origin + '/', fetchImpl)).body; } catch (e) {
      if (e.code === 'verboten') throw e;
      throw fehler(e.code || 'netz', 'Weder eine Sitemap noch die Startseite konnten gelesen werden.');
    }
    const re = /<a\s[^>]*href=["']([^"'#][^"']*)["']/gi;
    let m;
    const start = normalisieren(basis.origin + '/', basis);
    if (start) seiten.set(start.url, start);
    while ((m = re.exec(html))) {
      if (/^(mailto:|tel:|javascript:)/i.test(m[1])) continue;
      const n = normalisieren(m[1], basis);
      if (n && !seiten.has(n.url)) seiten.set(n.url, n);
    }
  }
  return [...seiten.values()].slice(0, Math.max(0, maxSeiten));
}

// ---------- Seite lesen ----------

function entities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü').replace(/&szlig;/g, 'ß')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } });
}
function nurText(s) { return entities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function entfernen(html, tag) { return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' '); }

async function seiteLesen(url, { fetchImpl } = {}) {
  const r = await laden(url, fetchImpl);
  let html = r.body.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const t of ['script', 'style', 'noscript', 'svg']) html = entfernen(html, t);

  const titelRoh = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const metaTag = (html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i) || [])[0] || '';
  const metaRoh = (metaTag.match(/content=["']([^"']*)["']/i) || [])[1] || '';
  const sprache = ((html.match(/<html\b[^>]*\blang=["']([a-zA-Z-]+)["']/i) || [])[1] || '').slice(0, 2).toLowerCase();

  // Inhaltsbereich: main, sonst body ohne Navigation, Kopf, Fuss, Formulare
  const main = html.match(/<main\b[\s\S]*?<\/main\s*>/i);
  let inhalt = main ? main[0] : ((html.match(/<body\b[\s\S]*<\/body\s*>/i) || [html])[0]);
  for (const t of ['nav', 'header', 'footer', 'form']) inhalt = entfernen(inhalt, t);

  const sammeln = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
    let m;
    while ((m = re.exec(inhalt))) { const t = nurText(m[1]); if (t) out.push(t); }
    return out;
  };

  let bilderOhneAlt = 0;
  const imgRe = /<img\b[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(inhalt))) {
    const alt = im[0].match(/\balt=(?:"([^"]*)"|'([^']*)')/i);
    if (!alt || !(alt[1] || alt[2] || '').trim()) bilderOhneAlt++;
  }

  const text = entities(
    inhalt
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|figure|dd|dt)\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const woerter = text ? text.split(/\s+/).length : 0;
  return {
    url: r.url,
    titel: nurText(titelRoh),
    metaBeschreibung: entities(metaRoh).trim(),
    h1: sammeln('h1'),
    h2: sammeln('h2'),
    text,
    woerter,
    sprache,
    bilderOhneAlt
  };
}

// Grobe Schätzung des seitenspezifischen Textes: Wörter abzüglich pauschaler Vorlagenwörter.
function eigenerText(seite, vorlagenWoerter = 240) {
  const woerter = Math.max(0, ((seite && seite.woerter) || 0) - vorlagenWoerter);
  return { woerter, vermutlichTextseite: woerter >= 100 };
}

module.exports = { sitemapSeiten, seiteLesen, eigenerText };
