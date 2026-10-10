// Kalenderdatei (iCalendar) lesen: VEVENT mit einfacher Wiederholung (täglich, wöchentlich, monatlich, jährlich, INTERVAL,
// UNTIL, COUNT, BYDAY, BYMONTHDAY, EXDATE, RECURRENCE-ID), Zeitzonen (TZID, UTC, schwebend) und ganztägige Termine.
// Reine Funktionen ohne Netz und Datenbank. Die Ergebnisse sind Zürcher Daten 'YYYY-MM-DD' und Minuten ab Mitternacht.
const Z = require('./zeit');

const WINDOWS_ZONEN = {
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'UTC', 'UTC': 'UTC',
  'E. Europe Standard Time': 'Europe/Bucharest', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles', 'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo'
};
const ZONE_STANDARD = 'Europe/Zurich';
const MAX_VORKOMMEN = 5000;

const fmtCache = new Map();
function zoneGueltig(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}
function zoneNormal(tz) {
  const t = String(tz || '').trim().replace(/^"|"$/g, '');
  if (!t) return ZONE_STANDARD;
  if (WINDOWS_ZONEN[t]) return WINDOWS_ZONEN[t];
  return zoneGueltig(t) ? t : ZONE_STANDARD;
}
function teile(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); fmtCache.set(tz, f); }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
// Wanduhrzeit in einer Zeitzone als echter Zeitpunkt (Millisekunden)
function zuInstant(datum, min, tz) {
  const [y, m, d] = datum.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, min);
  const off = (ts) => { const p = teile(ts, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - ts; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}

// ── Zeilen und Eigenschaften ──
function zeilen(text) {
  const roh = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const z of roh) {
    if ((z.startsWith(' ') || z.startsWith('\t')) && out.length) out[out.length - 1] += z.slice(1);
    else out.push(z);
  }
  return out.filter(z => z.length);
}
function eigenschaft(zeile) {
  // NAME;PARAM=WERT;PARAM="WERT":Wert  (Doppelpunkte in Anführungszeichen beachten)
  let inQ = false, idx = -1;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { idx = i; break; }
  }
  if (idx < 1) return null;
  const kopf = zeile.slice(0, idx), wert = zeile.slice(idx + 1);
  const teileK = []; let cur = ''; inQ = false;
  for (const c of kopf) { if (c === '"') inQ = !inQ; if (c === ';' && !inQ) { teileK.push(cur); cur = ''; } else cur += c; }
  teileK.push(cur);
  const name = teileK.shift().toUpperCase();
  const par = {};
  for (const p of teileK) { const e = p.indexOf('='); if (e > 0) par[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, ''); }
  return { name, par, wert };
}
function entmaskiere(t) { return String(t || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }

// Datumswert: { datum, min|null (ganztägig), utc }
function zeitWert(p) {
  const w = String(p.wert || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(w);
  if (!m) return null;
  const datum = `${m[1]}-${m[2]}-${m[3]}`;
  if (!Z.istDatum(datum)) return null;
  if (m[4] == null || (p.par.VALUE || '').toUpperCase() === 'DATE') return { datum, min: null, tz: null };
  const min = +m[4] * 60 + +m[5];
  if (m[7]) return { datum, min, tz: 'UTC' };
  return { datum, min, tz: zoneNormal(p.par.TZID) };
}
function dauerMinuten(w) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(w || '').trim());
  if (!m) return null;
  const v = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0);
  return m[1] === '-' ? -v : v;
}
function minutenZwischen(a, b, tz) { // von a (datum, min) bis b (datum, min), beide in tz
  return Math.round((zuInstant(b.datum, b.min, tz) - zuInstant(a.datum, a.min, tz)) / 60000);
}

const TAGE = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
function regel(wert) {
  const r = { freq: null, interval: 1, count: null, untilMs: null, untilDatum: null, byday: [], bymonthday: [] };
  for (const teil of String(wert || '').split(';')) {
    const e = teil.indexOf('=');
    if (e < 1) continue;
    const k = teil.slice(0, e).toUpperCase(), v = teil.slice(e + 1);
    if (k === 'FREQ') r.freq = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(v.toUpperCase()) ? v.toUpperCase() : null;
    else if (k === 'INTERVAL') r.interval = Math.max(1, Math.min(999, parseInt(v, 10) || 1));
    else if (k === 'COUNT') r.count = Math.max(1, Math.min(MAX_VORKOMMEN, parseInt(v, 10) || 1));
    else if (k === 'UNTIL') {
      const t = zeitWert({ par: {}, wert: v });
      if (t) { r.untilDatum = t.datum; r.untilMs = t.min == null ? null : (t.tz === 'UTC' ? zuInstant(t.datum, t.min, 'UTC') : null); }
    } else if (k === 'BYDAY') {
      for (const x of v.split(',')) { const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(x.trim()); if (m) r.byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, d: TAGE[m[2].toUpperCase()] }); }
    } else if (k === 'BYMONTHDAY') {
      for (const x of v.split(',')) { const n = parseInt(x, 10); if (n >= 1 && n <= 31) r.bymonthday.push(n); }
    }
  }
  return r.freq ? r : null;
}

// ── Lesen ──
// Ergebnis: Liste einfacher Objekte (JSON-tauglich):
//  { u, t, g (ganztägig), s (Datum), sm (Minute), tz, dm (Dauer in Minuten) oder dt (Tage), r (Regel), x (Ausnahmedaten), o (Einzeländerungen), frei }
function lies(text) {
  const z = zeilen(text);
  const roh = [];
  let cur = null, tief = 0;
  for (const l of z) {
    const p = eigenschaft(l);
    if (!p) continue;
    if (p.name === 'BEGIN') { if (p.wert.toUpperCase() === 'VEVENT' && !cur) cur = { p: [] }; else if (cur) tief++; continue; }
    if (p.name === 'END') { if (p.wert.toUpperCase() === 'VEVENT' && cur && !tief) { roh.push(cur); cur = null; } else if (cur && tief) tief--; continue; }
    if (cur && !tief) cur.p.push(p);
  }
  const master = new Map(), aenderungen = [];
  for (const e of roh) {
    const get = (n) => e.p.find(p => p.name === n);
    const alle = (n) => e.p.filter(p => p.name === n);
    const st = get('STATUS');
    const cancelled = !!st && /^CANCELLED$/i.test(st.wert.trim());
    const ds = get('DTSTART');
    const s = ds && zeitWert(ds);
    const uid = (get('UID') || {}).wert || '';
    const rid = get('RECURRENCE-ID');
    if (!s && !(rid && cancelled)) continue;
    let ev = null;
    if (s) {
      const ganz = s.min == null;
      ev = { u: uid, t: entmaskiere((get('SUMMARY') || {}).wert).slice(0, 80), g: ganz, s: s.datum, sm: ganz ? null : s.min, tz: ganz ? null : s.tz };
      const tr = get('TRANSP');
      ev.frei = !!tr && /^TRANSPARENT$/i.test(tr.wert.trim());
      const de = get('DTEND'), du = get('DURATION');
      const en = de && zeitWert(de);
      if (ganz) {
        let tage = 1;
        if (en && en.min == null) tage = Math.max(1, Z.tageZwischen(s.datum, en.datum));
        else if (du) tage = Math.max(1, Math.ceil((dauerMinuten(du.wert) || 1440) / 1440));
        ev.dt = Math.min(tage, 366);
      } else {
        let dm = null;
        if (en && en.min != null) dm = minutenZwischen({ datum: s.datum, min: s.min }, { datum: en.datum, min: en.min }, en.tz === 'UTC' && s.tz !== 'UTC' ? 'UTC' : s.tz);
        else if (en && en.min == null) dm = Math.max(0, Z.tageZwischen(s.datum, en.datum)) * 1440;
        else if (du) dm = dauerMinuten(du.wert);
        if (en && en.min != null && en.tz !== s.tz) dm = Math.round((zuInstant(en.datum, en.min, en.tz) - zuInstant(s.datum, s.min, s.tz)) / 60000);
        ev.dm = dm != null && dm > 0 ? Math.min(dm, 60 * 24 * 14) : 30;
      }
    }
    if (rid) {
      const r = zeitWert(rid);
      if (r) aenderungen.push({ u: uid, rid: r.datum, del: cancelled, ev });
      continue;
    }
    if (cancelled || !ev) continue;
    const rr = get('RRULE');
    ev.r = rr ? regel(rr.wert) : null;
    ev.x = [];
    for (const x of alle('EXDATE')) for (const w of x.wert.split(',')) { const t = zeitWert({ par: x.par, wert: w }); if (t) ev.x.push(t.datum); }
    ev.o = [];
    // gleiche UID mehrfach ohne RECURRENCE-ID: das letzte gilt
    master.set(uid || `__${master.size}`, ev);
  }
  for (const a of aenderungen) {
    const m = master.get(a.u);
    if (m) m.o.push({ rid: a.rid, del: a.del, ev: a.ev && !a.del ? { t: a.ev.t, g: a.ev.g, s: a.ev.s, sm: a.ev.sm, tz: a.ev.tz, dm: a.ev.dm, dt: a.ev.dt, frei: a.ev.frei } : null });
  }
  return [...master.values()].slice(0, 3000);
}

// ── Wiederholungen ausrollen ──
const dtag = (datum) => new Date(datum + 'T00:00:00Z');
function wochentagsListe(r, ev) { return r.byday.length ? [...new Set(r.byday.map(b => b.d))] : [Z.wd(ev.s)]; }
function nteWochentag(jahr, monat, wdTag, n) { // n>0: n-ter, n<0: von hinten; Datum oder null
  const tage = new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
  const liste = [];
  for (let d = 1; d <= tage; d++) { const ds = `${jahr}-${Z.p2(monat)}-${Z.p2(d)}`; if (Z.wd(ds) === wdTag) liste.push(ds); }
  const i = n > 0 ? n - 1 : liste.length + n;
  return liste[i] || null;
}
function vorkommenDaten(ev, bisDatum) {
  const r = ev.r;
  if (!r) return [ev.s];
  const out = [];
  const max = r.count || MAX_VORKOMMEN;
  const ok = (d) => (!r.untilDatum || d <= r.untilDatum) && d <= bisDatum;
  const fuege = (d) => { if (d >= ev.s && out.length < max && ok(d)) out.push(d); };
  let guard = 0;
  if (r.freq === 'DAILY') {
    for (let d = ev.s; ok(d) && out.length < max && guard++ < 9000; d = Z.addTage(d, r.interval)) out.push(d);
  } else if (r.freq === 'WEEKLY') {
    const tage = wochentagsListe(r, ev).sort((a, b) => a - b);
    for (let w = Z.montagVon(ev.s); w <= bisDatum && out.length < max && guard++ < 3000; w = Z.addTage(w, 7 * r.interval)) {
      for (const t of tage) { const d = Z.addTage(w, t - 1); if (d >= ev.s && !(r.untilDatum && d > r.untilDatum)) { if (out.length < max && d <= bisDatum) out.push(d); } }
    }
  } else if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    const y0 = +ev.s.slice(0, 4), m0 = +ev.s.slice(5, 7);
    const schritt = r.freq === 'YEARLY' ? 12 * r.interval : r.interval;
    for (let k = 0; guard++ < 2000; k += schritt) {
      const mi = m0 - 1 + k, y = y0 + Math.floor(mi / 12), m = (mi % 12) + 1;
      const monatsStart = `${y}-${Z.p2(m)}-01`;
      if (monatsStart > bisDatum || out.length >= max) break;
      const kand = [];
      if (r.bymonthday.length) for (const n of r.bymonthday) { const ds = `${y}-${Z.p2(m)}-${Z.p2(n)}`; if (Z.istDatum(ds)) kand.push(ds); }
      else if (r.byday.length && r.freq === 'MONTHLY') for (const b of r.byday) {
        if (b.n) { const ds = nteWochentag(y, m, b.d, b.n); if (ds) kand.push(ds); }
        else { const tage = new Date(Date.UTC(y, m, 0)).getUTCDate(); for (let d = 1; d <= tage; d++) { const ds = `${y}-${Z.p2(m)}-${Z.p2(d)}`; if (Z.wd(ds) === b.d) kand.push(ds); } }
      } else { const ds = `${y}-${Z.p2(m)}-${ev.s.slice(8, 10)}`; if (Z.istDatum(ds)) kand.push(ds); }
      for (const d of [...new Set(kand)].sort()) { if (d >= ev.s) { if (out.length >= max || (r.untilDatum && d > r.untilDatum)) break; if (d <= bisDatum) out.push(d); } }
    }
  }
  return out;
}

// Eine Instanz in Zürcher Tage zerlegen
function inTage(i) {
  const out = [];
  if (i.g) {
    for (let k = 0; k < (i.dt || 1); k++) out.push({ datum: Z.addTage(i.s, k), beginn: null, ende: null, ganztaegig: true, titel: i.t, frei: !!i.frei });
    return out;
  }
  const von = new Date(zuInstant(i.s, i.sm, i.tz || ZONE_STANDARD));
  const bis = new Date(von.getTime() + (i.dm || 30) * 60000);
  const a = Z.zurich(von), b = Z.zurich(bis);
  if (a.datum === b.datum) { out.push({ datum: a.datum, beginn: a.min, ende: Math.max(b.min, a.min + 1), ganztaegig: false, titel: i.t, frei: !!i.frei }); return out; }
  out.push({ datum: a.datum, beginn: a.min, ende: 1440, ganztaegig: false, titel: i.t, frei: !!i.frei });
  let d = Z.addTage(a.datum, 1);
  for (let n = 0; d < b.datum && n < 20; n++, d = Z.addTage(d, 1)) out.push({ datum: d, beginn: 0, ende: 1440, ganztaegig: false, titel: i.t, frei: !!i.frei });
  if (b.min > 0) out.push({ datum: b.datum, beginn: 0, ende: b.min, ganztaegig: false, titel: i.t, frei: !!i.frei });
  return out;
}

// Alle Termine der Masterliste, die einen Tag zwischen von und bis (einschliesslich) berühren
function expandiere(master, von, bis) {
  const out = [];
  const fensterBis = Z.addTage(bis, 3);
  for (const ev of master || []) {
    const overr = new Map((ev.o || []).map(o => [o.rid, o]));
    const ausn = new Set(ev.x || []);
    const instanzen = [];
    for (const d of vorkommenDaten(ev, fensterBis)) {
      if (ausn.has(d) || overr.has(d)) continue;
      instanzen.push({ ...ev, s: d });
    }
    for (const o of ev.o || []) if (!o.del && o.ev) instanzen.push({ ...o.ev, t: o.ev.t || ev.t });
    for (const i of instanzen) {
      if (!i.g && i.dm == null) i.dm = ev.dm || 30;
      if (i.g && i.dt == null) i.dt = ev.dt || 1;
      for (const t of inTage(i)) if (t.datum >= von && t.datum <= bis) out.push(t);
    }
  }
  return out.sort((a, b) => a.datum.localeCompare(b.datum) || (a.beginn == null ? -1 : a.beginn) - (b.beginn == null ? -1 : b.beginn));
}

module.exports = { lies, expandiere, zuInstant, zoneNormal, regel, zeilen };
