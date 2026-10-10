// Kalenderdatei (iCalendar, RFC 5545) für den Tagesplan. Reine Funktionen ohne Datenbank.
// Zeiten mit TZID=Europe/Zurich und VTIMEZONE. Keine Gedankenstriche, keine Klienteninhalte (nur Name, Textart, Frist).
const Z = require('./zeit');

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Zurich',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'
];

function ohneStriche(t) { return String(t == null ? '' : t).replace(/\s*[–—―]\s*/g, ', ').replace(/\s{2,}/g, ' ').trim(); }
// Text-Wert maskieren: Backslash, Semikolon, Komma, Zeilenumbruch; Steuerzeichen entfernen
function maskiere(t) {
  return ohneStriche(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
// Zeilen auf höchstens 75 Oktette falten, nie mitten in einem UTF-8-Zeichen
function falte(zeile) {
  const out = [];
  let cur = '', len = 0, limit = 75;
  for (const ch of zeile) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (len + b > limit) { out.push(cur); cur = ' '; len = 1; limit = 75; }
    cur += ch; len += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
function utcStempel(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function lokal(datum, min) { return datum.replace(/-/g, '') + 'T' + Z.p2(Math.floor(min / 60)) + Z.p2(min % 60) + '00'; }

// ereignisse: [{ uid, datum, beginn (Min), ende (Min), ganztaegig, titel, beschreibung, url, sequenz }]
function baueIcs(ereignisse, { name = 'RhetorIQ Tagesplan', jetzt = new Date(), abo = false } = {}) {
  const z = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RhetorIQ//Tagesplan//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + maskiere(name), 'X-WR-TIMEZONE:Europe/Zurich'];
  if (abo) z.push('REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M');
  z.push(...VTIMEZONE);
  const stamp = utcStempel(jetzt);
  for (const e of ereignisse || []) {
    z.push('BEGIN:VEVENT', 'UID:' + String(e.uid).replace(/[^A-Za-z0-9@._-]/g, ''), 'DTSTAMP:' + stamp, 'LAST-MODIFIED:' + stamp);
    if (e.sequenz != null) z.push('SEQUENCE:' + Math.max(0, Math.floor(e.sequenz)));
    if (e.ganztaegig) {
      z.push('DTSTART;VALUE=DATE:' + e.datum.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + Z.addTage(e.datumBis || e.datum, 1).replace(/-/g, ''), 'TRANSP:TRANSPARENT');
    } else {
      z.push('DTSTART;TZID=Europe/Zurich:' + lokal(e.datum, e.beginn), 'DTEND;TZID=Europe/Zurich:' + lokal(e.datum, e.ende));
    }
    z.push('SUMMARY:' + maskiere(e.titel));
    if (e.beschreibung) z.push('DESCRIPTION:' + maskiere(e.beschreibung));
    if (e.url) z.push('URL:' + String(e.url).replace(/[\r\n\s]/g, ''));
    z.push('END:VEVENT');
  }
  z.push('END:VCALENDAR');
  return z.map(falte).join('\r\n') + '\r\n';
}

module.exports = { baueIcs, maskiere, falte, ohneStriche, VTIMEZONE };
