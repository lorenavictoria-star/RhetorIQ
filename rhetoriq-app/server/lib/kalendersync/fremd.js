// Besetzt-Zeiten aus fremden Kalendern (iCloud, Outlook): veröffentlichte ICS-Links, nur lesen.
// Der Link ist ein Geheimnis. Er liegt nur verschlüsselt in der Datenbank (lib/secretBox.js), wird nie geloggt, nie in Fehlertexten genannt
// und nie an das Frontend zurückgegeben.
// Schutz gegen SSRF: nur https (webcal wird zu https), kein Port ausser 443, keine Zugangsdaten in der Adresse, jede aufgelöste IP-Adresse wird geprüft
// (auch nach Weiterleitungen, höchstens 3), Antwortgrösse und Dauer sind begrenzt.
const https = require('https');
const net = require('net');
const secretBox = require('../secretBox');
const { isBlockedAddress, guardedLookup } = require('../safeFetch');
const { lies } = require('../icsLesen');
const KD = require('./daten');

const LIMITS = { timeoutMs: 15000, maxBytes: 5 * 1024 * 1024, weiterleitungen: 3, minAbstandMs: 5 * 60000 };

class FremdFehler extends Error { constructor(msg) { super(msg); this.name = 'FremdFehler'; } }

// Adresse prüfen. Liefert eine URL oder wirft FremdFehler (mit Text für die Beraterin, ohne die Adresse selbst).
function pruefeUrl(eingabe) {
  let s = String(eingabe == null ? '' : eingabe).trim();
  if (!s) throw new FremdFehler('Bitte füge den Link ein.');
  if (s.length > 2000) throw new FremdFehler('Der Link ist zu lang.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) throw new FremdFehler('Der Link muss mit https:// oder webcal:// beginnen.');
  let u;
  try { u = new URL(s); } catch { throw new FremdFehler('Der Link ist ungültig.'); }
  if (u.protocol !== 'https:') throw new FremdFehler('Der Link muss mit https:// oder webcal:// beginnen.');
  if (u.username || u.password) throw new FremdFehler('Zugangsdaten im Link sind nicht erlaubt.');
  if (u.port && u.port !== '443') throw new FremdFehler('Dieser Anschluss ist nicht erlaubt.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')) throw new FremdFehler('Diese Adresse ist nicht erlaubt.');
  if (net.isIP(host) && isBlockedAddress(host)) throw new FremdFehler('Diese Adresse ist nicht erlaubt.');
  return u;
}

// Eine Anfrage ohne Weiterleitungen. Austauschbar für Tests.
const netz = {
  einmal(u, { etag, lastModified }) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'RhetorIQ-Kalender/1.0', Accept: 'text/calendar, text/plain;q=0.5', 'Accept-Encoding': 'identity' };
      if (etag) headers['If-None-Match'] = etag;
      if (lastModified) headers['If-Modified-Since'] = lastModified;
      const gesamt = setTimeout(() => req.destroy(new FremdFehler('Zeitüberschreitung')), LIMITS.timeoutMs);
      const req = https.request(u, { method: 'GET', lookup: guardedLookup, headers, timeout: LIMITS.timeoutMs }, res => {
        const status = res.statusCode || 0;
        if (status === 304) { res.resume(); clearTimeout(gesamt); return resolve({ status }); }
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); clearTimeout(gesamt);
          let ziel; try { ziel = new URL(res.headers.location, u).toString(); } catch { return reject(new FremdFehler('Ungültige Weiterleitung.')); }
          return resolve({ status, weiter: ziel });
        }
        if (status < 200 || status >= 300) { res.resume(); clearTimeout(gesamt); return reject(new FremdFehler(`Der Kalender antwortet mit Status ${status}.`)); }
        const teile = []; let n = 0;
        res.on('data', c => {
          n += c.length;
          if (n > LIMITS.maxBytes) { clearTimeout(gesamt); req.destroy(new FremdFehler('Die Antwort ist zu gross.')); return; }
          teile.push(c);
        });
        res.on('end', () => { clearTimeout(gesamt); resolve({ status, text: Buffer.concat(teile).toString('utf8'), etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null }); });
        res.on('error', e => { clearTimeout(gesamt); reject(e); });
      });
      req.on('timeout', () => req.destroy(new FremdFehler('Zeitüberschreitung')));
      req.on('error', e => { clearTimeout(gesamt); reject(e); });
      req.end();
    });
  }
};
const netzEcht = { einmal: netz.einmal }; // unverändert für Tests der Grenzen
function _setNetz(o) { Object.assign(netz, o); }

// Text für die Beraterin, ohne Adresse und ohne technische Einzelheiten
function freundlich(e) {
  if (e instanceof FremdFehler) return e.message;
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Der Kalender ist nicht erreichbar (Adresse nicht gefunden).';
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'ETIMEDOUT' || c === 'EHOSTUNREACH') return 'Der Kalender ist nicht erreichbar.';
  if (e && /nicht erlaubt/.test(String(e.message))) return 'Diese Adresse ist nicht erlaubt.';
  return 'Der Kalender konnte nicht gelesen werden.';
}

async function holeIcs(eingabe, { etag, lastModified } = {}) {
  let u = pruefeUrl(eingabe);
  for (let hop = 0; hop <= LIMITS.weiterleitungen; hop++) {
    const r = await netz.einmal(u, { etag, lastModified });
    if (r.weiter) { u = pruefeUrl(r.weiter); continue; } // jede Weiterleitung wird erneut geprüft
    if (r.status === 304) return { unveraendert: true };
    if (!/BEGIN:VCALENDAR/i.test(r.text || '')) throw new FremdFehler('Das ist keine Kalenderdatei. Bitte prüfe den Link.');
    return { text: r.text, etag: r.etag || null, lastModified: r.lastModified || null };
  }
  throw new FremdFehler('Zu viele Weiterleitungen.');
}

// Einen gespeicherten Kalender neu lesen. Fehler werden pro Quelle festgehalten, der Plan läuft ohne diese Quelle weiter.
async function aktualisieren(zeile) {
  try {
    const url = secretBox.decrypt(zeile.url_enc);
    const r = await holeIcs(url, { etag: zeile.etag, lastModified: zeile.last_modified });
    if (r.unveraendert) { await KD.fremdErgebnis(zeile.id, { ok: true }); return { ok: true, geaendert: false }; }
    const master = lies(r.text);
    await KD.fremdErgebnis(zeile.id, { ok: true, ereignisse: JSON.stringify(master), etag: r.etag, lastModified: r.lastModified });
    return { ok: true, geaendert: true, anzahl: master.length };
  } catch (e) {
    const text = e && (e.code === 'NO_SECRET' || e.code === 'BAD_SECRET') ? 'Der gespeicherte Link ist nicht lesbar. Bitte füge den Kalender neu hinzu.' : freundlich(e);
    await KD.fremdErgebnis(zeile.id, { ok: false, fehler: text });
    console.error('[kalender-fremd] Abruf', zeile.id, 'fehlgeschlagen'); // bewusst ohne Adresse und ohne Fehlertext
    return { ok: false, fehler: text };
  }
}

async function alleAktualisieren({ aid = null, mindestensAlt = false } = {}) {
  const zeilen = aid ? (await KD.fremdAlle(aid)).filter(z => z.aktiv) : await KD.fremdAlleAktiven();
  let geaendert = 0;
  for (const z of zeilen) {
    if (mindestensAlt && z.abgerufen_am && Date.now() - new Date(z.abgerufen_am).getTime() < LIMITS.minAbstandMs) continue;
    const r = await aktualisieren(z);
    if (r.geaendert) geaendert++;
  }
  return { geaendert };
}

module.exports = { pruefeUrl, holeIcs, aktualisieren, alleAktualisieren, freundlich, FremdFehler, LIMITS, netzEcht, _setNetz };
