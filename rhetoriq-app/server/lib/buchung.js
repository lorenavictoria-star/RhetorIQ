// Terminbuchung: Verfügbarkeit, Einstellungen, Eingabeprüfung, Zeitfenster-Ticket und Kalenderdatei. Reine Funktionen ohne Datenbank.
// Alle Uhrzeiten sind Minuten ab Mitternacht in Europe/Zurich, Daten 'YYYY-MM-DD'. Zeitpunkte sind echte Date-Werte (Sommer-/Winterzeit über lib/zeit.js).
const crypto = require('crypto');
const Z = require('./zeit');
const { baueIcs } = require('./ics');

const STANDARD_TAG = { an: true, von: 540, bis: 960, pause_von: 720, pause_bis: 780 };
const STANDARD = {
  aktiv: false,
  dauer: 20, puffer: 15, vorlauf: 12, horizont: 14, raster: 30,
  // Wochentage 1 (Montag) bis 7 (Sonntag). Samstag und Sonntag sind nie buchbar.
  tage: { 1: { ...STANDARD_TAG }, 2: { ...STANDARD_TAG }, 3: { ...STANDARD_TAG }, 4: { ...STANDARD_TAG }, 5: { ...STANDARD_TAG }, 6: { ...STANDARD_TAG, an: false }, 7: { ...STANDARD_TAG, an: false } },
  kontakt_text: 'Ich melde mich zur vereinbarten Zeit telefonisch oder per Videolink bei Ihnen.',
  kontakt_link: ''
};
const RASTER_ERLAUBT = [15, 20, 30, 60];

const ganz = (v, min, max, std) => (Number.isInteger(v) && v >= min && v <= max ? v : std);
const einZeile = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s*[–—―]\s*/g, ', ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

// Nur https-Links ohne Leerzeichen und ohne Zeilenumbruch sind erlaubt
function sichererLink(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) return '';
  if (s.length > 300 || /[\s\u0000-\u001f<>"']/.test(s)) return '';
  try { const u = new URL(s); return u.protocol === 'https:' && u.hostname ? u.toString() : ''; } catch { return ''; }
}

function einstellungen(roh) {
  const o = roh && typeof roh === 'object' ? roh : {};
  const s = JSON.parse(JSON.stringify(STANDARD));
  s.aktiv = o.aktiv === true;
  s.dauer = ganz(o.dauer, 10, 120, s.dauer);
  s.puffer = ganz(o.puffer, 0, 120, s.puffer);
  s.vorlauf = ganz(o.vorlauf, 0, 168, s.vorlauf);
  s.horizont = ganz(o.horizont, 1, 60, s.horizont);
  s.raster = RASTER_ERLAUBT.includes(o.raster) ? o.raster : s.raster;
  if (o.tage && typeof o.tage === 'object') {
    for (let wd = 1; wd <= 7; wd++) {
      const t = o.tage[wd];
      if (!t || typeof t !== 'object') continue;
      const neu = { ...s.tage[wd] };
      neu.an = t.an === true && wd <= 5; // Wochenenden bleiben aus
      if (t.an === false) neu.an = false;
      const von = ganz(t.von, 0, 1439, neu.von), bis = ganz(t.bis, 1, 1440, neu.bis);
      if (von < bis) { neu.von = von; neu.bis = bis; }
      if (t.pause_von === null && t.pause_bis === null) { neu.pause_von = null; neu.pause_bis = null; }
      else {
        const pv = ganz(t.pause_von, 0, 1439, null), pb = ganz(t.pause_bis, 1, 1440, null);
        if (pv != null && pb != null && pv < pb) { neu.pause_von = pv; neu.pause_bis = pb; }
      }
      s.tage[wd] = neu;
    }
  }
  s.tage[6].an = false; s.tage[7].an = false;
  s.kontakt_text = einZeile(o.kontakt_text, 300) || STANDARD.kontakt_text;
  s.kontakt_link = sichererLink(o.kontakt_link);
  return s;
}

// Besetzte Zeiten eines Tages aus allen Quellen. eintraege: Einträge wie T.eintraegeAm sie liefert plus fremde Kalender und Google-Termine
// (mit fremd:true bzw. google:true und frei). Liefert { ganz: Tag gesperrt, iv: [[von, bis], ...] }.
function belegungAus(eintraege) {
  const out = { ganz: false, iv: [] };
  for (const e of eintraege || []) {
    if (!e) continue;
    if (e.typ === 'ferien' || e.typ === 'feiertag') { out.ganz = true; continue; }
    if (e.ganztaegig || e.beginn == null || e.ende == null) {
      if (e.fremd && e.frei) continue;
      out.ganz = true; continue;
    }
    if (e.fremd && e.frei) continue; // als «frei» oder «verfügbar» markierte Termine sperren keine Zeit
    out.iv.push([e.beginn, e.ende]);
  }
  return out;
}

function ueberlappt(a0, a1, b0, b1) { return a0 < b1 && a1 > b0; }

// Freie Zeitfenster. belegung(datum) liefert { ganz, iv }. Gibt eine Liste { datum, beginn, start (Date), ende (Date) } zurück.
function freieZeiten({ jetzt = new Date(), s, belegung }) {
  const out = [];
  const heute = Z.heute(jetzt);
  const fruehestens = jetzt.getTime() + s.vorlauf * 3600000;
  const spaetestens = jetzt.getTime() + s.horizont * 86400000;
  for (let i = 0; i <= s.horizont; i++) {
    const d = Z.addTage(heute, i);
    const wd = Z.wd(d);
    const tag = s.tage[wd];
    if (wd >= 6 || !tag || !tag.an) continue;
    if (Z.feiertagName(d)) continue;
    const bel = belegung ? belegung(d) : { ganz: false, iv: [] };
    if (bel.ganz) continue;
    const erster = Math.ceil(tag.von / s.raster) * s.raster;
    for (let m = erster; m + s.dauer <= tag.bis; m += s.raster) {
      if (tag.pause_von != null && ueberlappt(m, m + s.dauer, tag.pause_von, tag.pause_bis)) continue;
      if (bel.iv.some(([b, e]) => ueberlappt(m - s.puffer, m + s.dauer + s.puffer, b, e))) continue;
      const start = Z.zuDate(d, m);
      if (start.getTime() < fruehestens || start.getTime() > spaetestens) continue;
      out.push({ datum: d, beginn: m, start, ende: new Date(start.getTime() + s.dauer * 60000) });
    }
  }
  return out;
}

// Öffentliche Form: nach Tagen gruppiert, nur Zeitpunkte
function nachTagen(liste) {
  const tage = [];
  for (const z of liste) {
    let t = tage[tage.length - 1];
    if (!t || t.datum !== z.datum) {
      const [, mo, da] = z.datum.split('-');
      t = { datum: z.datum, label: Z.datumLang(z.datum), kurz: `${Z.KURZ[Z.wd(z.datum) % 7]} ${da}.${mo}.`, zeiten: [] };
      tage.push(t);
    }
    t.zeiten.push({ start: z.start.toISOString(), zeit: Z.hhmm(z.beginn) });
  }
  return tage;
}

// Prüft den gewünschten Zeitpunkt gegen die frisch berechnete Liste
function findeFenster(liste, startIso) {
  const t = Date.parse(String(startIso || ''));
  if (!Number.isFinite(t)) return null;
  return liste.find(z => z.start.getTime() === t) || null;
}

// ── Eingaben ──
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
function mehrzeilig(t, max) {
  return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}
// Liefert { werte } oder { fehler, feld }
function pruefeEingabe(b, { mitPersonalien = true } = {}) {
  const body = b && typeof b === 'object' ? b : {};
  for (const k of ['name', 'email', 'message', 'start', 'token']) {
    if (body[k] != null && typeof body[k] !== 'string') return { fehler: 'Die Angaben sind unvollständig oder ungültig.', feld: k };
  }
  const werte = { start: String(body.start || ''), token: String(body.token || '') };
  if (werte.start.length > 40) return { fehler: 'Bitte wählen Sie eine Zeit aus.', feld: 'start' };
  if (werte.token.length > 120) return { fehler: 'Dieser Link ist nicht gültig.', feld: 'token' };
  if (mitPersonalien) {
    const rohName = String(body.name || '');
    const name = einZeile(rohName, 200);
    if (name.length < 2 || name.length > 80 || /https?:|www\.|@|[<>]/i.test(name)) return { fehler: 'Bitte geben Sie Ihren Namen an.', feld: 'name' };
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 120 || !EMAIL_RE.test(email)) return { fehler: 'Bitte geben Sie eine gültige E-Mail-Adresse an.', feld: 'email' };
    const message = mehrzeilig(body.message, 1500);
    if (String(body.message || '').length > 3000) return { fehler: 'Das Anliegen ist zu lang. Bitte fassen Sie sich auf höchstens 1500 Zeichen.', feld: 'message' };
    if (body.einwilligung !== true) return { fehler: 'Bitte bestätigen Sie die Datenschutzerklärung.', feld: 'einwilligung' };
    werte.name = name; werte.email = email; werte.message = message;
  }
  return { werte };
}
// Zeilenumbrüche und Steuerzeichen haben in Kopfzeilen nichts verloren
const kopfzeilenSicher = (t) => !/[\r\n\u0000-\u001f\u2028\u2029]/.test(String(t));

// ── Zeitfenster-Ticket gegen schnelle Bots: der Server stempelt den Abruf der freien Zeiten ──
function geheimnis() { return process.env.BUCHUNG_SECRET || process.env.JWT_SECRET || 'rhetoriq-buchung'; }
function ticketNeu(jetzt = new Date()) {
  const ts = String(jetzt.getTime());
  return ts + '.' + crypto.createHmac('sha256', geheimnis()).update('ticket:' + ts).digest('base64url').slice(0, 32);
}
// Alter in Millisekunden oder null bei ungültigem Ticket
function ticketAlter(ticket, jetzt = new Date()) {
  const m = /^(\d{10,14})\.([A-Za-z0-9_-]{32})$/.exec(String(ticket || ''));
  if (!m) return null;
  const soll = crypto.createHmac('sha256', geheimnis()).update('ticket:' + m[1]).digest('base64url').slice(0, 32);
  const a = Buffer.from(soll), b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return jetzt.getTime() - Number(m[1]);
}

// ── Token für Absage und Verschiebung: nur der Hash wird gespeichert ──
const tokenNeu = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const tokenForm = (t) => /^[A-Za-z0-9_-]{43}$/.test(String(t || ''));

// ── Kalenderdatei für den Interessenten (Europe/Zurich) ──
function buchungIcs(b, { jetzt = new Date(), abgesagt = false, verwaltenUrl = '', kontaktText = '', kontaktLink = '', version = 0 } = {}) {
  const beschr = [`Gespräch von ${b.ende - b.beginn} Minuten mit Lorena Lienhard (RhetorIQ).`,
    kontaktText, kontaktLink ? 'Videolink: ' + kontaktLink : '', verwaltenUrl ? 'Absagen oder verschieben: ' + verwaltenUrl : ''].filter(Boolean).join('\n');
  return baueIcs([{
    uid: `rq-buchung-${b.id}@rhetoriq.ch`, datum: b.datum, beginn: b.beginn, ende: b.ende, ganztaegig: false,
    titel: 'Gespräch mit Lorena Lienhard (RhetorIQ)', beschreibung: beschr, url: kontaktLink || undefined,
    sequenz: abgesagt ? version + 1 : version, status: abgesagt ? 'CANCELLED' : undefined
  }], { name: 'Gespräch mit Lorena Lienhard', jetzt, methode: abgesagt ? 'CANCEL' : 'PUBLISH' });
}

module.exports = { STANDARD, STANDARD_TAG, einstellungen, belegungAus, freieZeiten, nachTagen, findeFenster, pruefeEingabe, kopfzeilenSicher, einZeile, mehrzeilig, sichererLink,
  ticketNeu, ticketAlter, tokenNeu, tokenHash, tokenForm, buchungIcs, EMAIL_RE };
