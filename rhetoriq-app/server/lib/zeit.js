// Datum und Uhrzeit in Europe/Zurich als reine Funktionen (Tagesplan, Kalender). Datum als 'YYYY-MM-DD', Zeit als Minuten ab Mitternacht.
const TZ = 'Europe/Zurich';
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const KURZ = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
const p2 = (n) => String(n).padStart(2, '0');

function istDatum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function zurich(date) {
  const p = parts(date);
  return { datum: `${p.y}-${p2(p.m)}-${p2(p.d)}`, min: p.h * 60 + p.mi };
}
function heute(now = new Date()) { return zurich(now).datum; }
// ISO-Wochentag: 1 = Montag ... 7 = Sonntag
function wd(datum) { const g = new Date(datum + 'T00:00:00Z').getUTCDay(); return g === 0 ? 7 : g; }
function addTage(datum, n) { const d = new Date(datum + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function tageZwischen(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function montagVon(datum) { return addTage(datum, 1 - wd(datum)); }

// Zürcher Wanduhrzeit in einen echten Zeitpunkt umrechnen (Sommer-/Winterzeit eingerechnet)
function zuDate(datum, min) {
  const [y, m, d] = datum.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, min);
  const off = (ts) => { const p = parts(new Date(ts)); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - ts; };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t);
}
function hhmm(min) { return `${p2(Math.floor(min / 60))}:${p2(min % 60)}`; }
// Strenge Prüfung 'H:MM', 'HH:MM', 'HH.MM' oder ganze Stunde; null bei Unsinn
function zeitZuMin(s) {
  if (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 24) return s * 60;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = +m[1], mi = m[2] == null ? 0 : +m[2];
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}
function osterSonntag(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${p2(mo)}-${p2(da)}`;
}
// Schweizweite Feiertage als Standard
function feiertage(y) {
  const o = osterSonntag(y);
  return {
    [`${y}-01-01`]: 'Neujahr', [addTage(o, -2)]: 'Karfreitag', [addTage(o, 1)]: 'Ostermontag', [addTage(o, 39)]: 'Auffahrt',
    [addTage(o, 50)]: 'Pfingstmontag', [`${y}-08-01`]: 'Bundesfeiertag', [`${y}-12-25`]: 'Weihnachten', [`${y}-12-26`]: 'Stephanstag'
  };
}
function feiertagName(datum) { return feiertage(+datum.slice(0, 4))[datum] || null; }
function datumLang(datum) { const [, m, d] = datum.split('-').map(Number); return `${WOCHENTAGE[wd(datum) % 7]}, ${d}. ${MONATE[m - 1]}`; }
function datumMitJahr(datum) { return `${datumLang(datum)} ${datum.slice(0, 4)}`; }

module.exports = { TZ, WOCHENTAGE, KURZ, MONATE, istDatum, zurich, heute, wd, addTage, tageZwischen, montagVon, zuDate, hhmm, zeitZuMin, feiertage, feiertagName, datumLang, datumMitJahr, p2 };
