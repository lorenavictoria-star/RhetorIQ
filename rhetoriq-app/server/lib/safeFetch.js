const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

// Sicherer Abruf einer fremden Webseite (Schutz gegen SSRF).
//  - nur http und https, nur Standardports 80 und 443
//  - jede aufgelöste IP-Adresse wird geprüft (kein Loopback, keine privaten, Link-Local-,
//    CGNAT-, Metadaten- oder Multicast-Adressen), auch nach Weiterleitungen
//  - die Prüfung läuft im Lookup des Sockets selbst, ein DNS-Wechsel nach der Prüfung greift also nicht
//  - Timeout, Grössenlimit, maximal 3 Weiterleitungen

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o, 10), 0) >>> 0;
}
function inRange4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([b, bits]) => inRange4(ip, b, bits));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^f[cd]/.test(v)) return true;      // fc00::/7 (unique local)
    if (/^fe[89ab]/.test(v)) return true;   // fe80::/10 (link local)
    if (/^ff/.test(v)) return true;         // multicast
    if (/^64:ff9b:/.test(v)) return true;   // NAT64
    return false;
  }
  return true;
}

function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
    const bad = list.find(a => isBlockedAddress(a.address));
    if (bad || !list.length) return cb(new Error('Diese Adresse ist nicht erlaubt.'));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function parseTarget(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Keine Webseite angegeben.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('Ungültige Webadresse.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Nur http und https sind erlaubt.');
  if (u.username || u.password) throw new Error('Zugangsdaten in der Adresse sind nicht erlaubt.');
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('Dieser Port ist nicht erlaubt.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Diese Adresse ist nicht erlaubt.');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error('Diese Adresse ist nicht erlaubt.');
  return u;
}

function requestOnce(u, { timeoutMs, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: lookup || guardedLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RhetorIQ/1.0)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
      timeout: timeoutMs
    }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      if (status < 200 || status >= 300) { res.resume(); return reject(new Error(`Die Webseite antwortet mit Status ${status}.`)); }
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) { chunks.push(c.subarray(0, c.length - (total - maxBytes))); req.destroy(); resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated: true }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated: false }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Laden der Webseite.')));
    req.on('error', reject);
    req.end();
  });
}

async function safeFetchHtml(input, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
  let u = parseTarget(input);
  for (let hop = 0; hop <= 3; hop++) {
    const r = await requestOnce(u, { timeoutMs, maxBytes, lookup: opts.lookup });
    if (r.redirect) { u = parseTarget(r.redirect); continue; }
    return { url: u.toString(), html: r.body, truncated: r.truncated };
  }
  throw new Error('Zu viele Weiterleitungen.');
}

function htmlToText(html, max = 12000) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
  const head = [title.trim() && `Titel: ${title.trim()}`, desc.trim() && `Beschreibung: ${desc.trim()}`].filter(Boolean).join('\n');
  return (head ? head + '\n\n' : '') + text.slice(0, max);
}

module.exports = { safeFetchHtml, htmlToText, isBlockedAddress, parseTarget };
