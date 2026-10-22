// Aktionen des Assistenten rund um Termine und Tagesplan. Die KI liefert nur Felder; Datum, Uhrzeit und Wochentage
// prüft und berechnet dieser Code (Europe/Zurich). Bei Unklarheit gibt es eine Rückfrage statt einer Aktion.
const Z = require('./zeit');
const T = require('./tagesplan');

const PLAN_AKTIONEN = ['termin_anlegen', 'ferien_anlegen', 'plan_zeigen', 'plan_neu', 'naechste_aufgabe', 'termine_zeigen'];
const TAGE = { montag: 1, mo: 1, dienstag: 2, di: 2, mittwoch: 3, mi: 3, donnerstag: 4, do: 4, freitag: 5, fr: 5, samstag: 6, sa: 6, sonntag: 7, so: 7 };

// Form für POST /api/tagesplan/termine (Uhrzeiten als HH:MM)
function apiForm(e) { return { ...e, beginn: e.beginn == null ? null : Z.hhmm(e.beginn), ende: e.ende == null ? null : Z.hhmm(e.ende) }; }
function frage(text) { return { type: 'answer', text, rueckfrage: true }; }

// 'YYYY-MM-DD', heute, morgen, uebermorgen oder ein Wochentagsname (nächstes Vorkommen nach heute). Sonst null.
function datumAufloesen(v, heute) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/ü/g, 'ue');
  if (Z.istDatum(s)) return s;
  if (s === 'heute') return heute;
  if (s === 'morgen') return Z.addTage(heute, 1);
  if (s === 'uebermorgen') return Z.addTage(heute, 2);
  if (TAGE[s]) { let n = TAGE[s] - Z.wd(heute); if (n <= 0) n += 7; return Z.addTage(heute, n); }
  return null;
}
function wochentageLesen(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    const n = typeof x === 'number' ? x : (TAGE[String(x).trim().toLowerCase()] || Number(x));
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    out.push(n);
  }
  return [...new Set(out)];
}
const tageText = (tage) => tage.map(n => Z.WOCHENTAGE[n % 7]).join(', ').replace(/, ([^,]*)$/, ' und $1');

function pruefePlanAktion(typ, o, { heute, settings } = {}) {
  heute = heute || Z.heute();
  if (typ === 'plan_neu') return { type: 'plan_neu' };
  if (typ === 'termine_zeigen') {
    const modus = o.modus === 'zeit' ? 'zeit' : 'termine';
    if (o.datum == null || o.datum === '') return { type: 'termine_zeigen', datum: heute, modus };
    const d = datumAufloesen(o.datum, heute);
    return d ? { type: 'termine_zeigen', datum: d, modus } : frage('Für welchen Tag soll ich nachschauen?');
  }
  if (typ === 'plan_zeigen') {
    if (o.datum == null || o.datum === '') return { type: 'plan_zeigen', datum: heute };
    const d = datumAufloesen(o.datum, heute);
    return d ? { type: 'plan_zeigen', datum: d } : frage('Für welchen Tag soll ich den Plan zeigen?');
  }
  if (typ === 'naechste_aufgabe') {
    if (o.minuten == null || o.minuten === '') return { type: 'naechste_aufgabe' };
    const m = Number(o.minuten);
    if (!Number.isInteger(m) || m < 5 || m > 720) return frage('Wie viel Zeit hast du? Nenne mir bitte Minuten oder Stunden.');
    return { type: 'naechste_aufgabe', minuten: m };
  }
  if (typ === 'ferien_anlegen') {
    const von = datumAufloesen(o.von, heute), bis = datumAufloesen(o.bis == null || o.bis === '' ? o.von : o.bis, heute);
    if (!von || !bis) return frage('Von wann bis wann sind die Ferien?');
    if (von < heute) return frage('Dieses Datum liegt schon hinter uns. Von wann bis wann sind die Ferien?');
    if (bis < von) return frage('Das Ende liegt vor dem Beginn. Von wann bis wann sind die Ferien?');
    if (Z.tageZwischen(von, bis) > 90) return frage('Das sind mehr als 90 Tage. Stimmt der Zeitraum?');
    const titel = T.bereinigeText(o.titel, 80) || 'Ferien';
    const p = T.eintragPruefen({ titel, typ: 'ferien', datum: von, ganztaegig: true, wiederholung: 'taeglich', bis }, { settings, heute, nurZukunft: true });
    if (p.fehler) return frage(p.frage || p.fehler);
    const text = von === bis ? `Ich trage «${titel}» am ${Z.datumMitJahr(von)} ganztägig ein. Stimmt das?`
      : `Ich trage «${titel}» vom ${Z.datumMitJahr(von)} bis ${Z.datumMitJahr(bis)} ganztägig ein. Stimmt das?`;
    return { type: 'ferien_anlegen', termin: apiForm(p.eintrag), bestaetigen: true, text };
  }
  // termin_anlegen
  const wh = o.wiederholung == null || o.wiederholung === '' ? 'keine' : String(o.wiederholung).toLowerCase().replace('ä', 'ae');
  if (!['keine', 'taeglich', 'woechentlich'].includes(wh)) return frage('Wie oft soll der Termin wiederkehren: einmalig, täglich oder wöchentlich?');
  const tage = wochentageLesen(o.wochentage);
  if (tage === null) return frage('Welche Wochentage meinst du?');
  if (wh === 'woechentlich' && !tage.length && !datumAufloesen(o.datum, heute)) return frage('An welchem Wochentag soll der Termin stattfinden?');
  let datum = datumAufloesen(o.datum, heute);
  if (!datum && wh === 'woechentlich' && tage.length) {
    datum = heute;
    for (let i = 0; i < 7 && !tage.includes(Z.wd(datum)); i++) datum = Z.addTage(datum, 1);
  }
  if (!datum) return frage('Für welchen Tag soll ich den Termin eintragen?');
  if (datum < heute) return frage('Dieses Datum liegt schon hinter uns. Welchen Tag meinst du?');
  const ganztaegig = o.ganztaegig === true;
  let beginn = null, ende = null, endeStandard = false;
  if (!ganztaegig) {
    beginn = Z.zeitZuMin(o.beginn);
    if (beginn == null || beginn >= 1440) return frage('Um wie viel Uhr beginnt der Termin?');
    if (o.ende == null || o.ende === '') { ende = Math.min(1440, beginn + 60); endeStandard = true; }
    else { ende = Z.zeitZuMin(o.ende); if (ende == null || ende <= beginn) return frage('Das Ende liegt nicht nach dem Beginn. Bis wann dauert der Termin?'); }
  }
  const p = T.eintragPruefen({
    titel: o.titel, typ: o.typ, datum, beginn: beginn == null ? null : Z.hhmm(beginn), ende: ende == null ? null : Z.hhmm(ende), ganztaegig,
    wiederholung: wh, wochentage: tage, bis: o.bis == null || o.bis === '' ? null : datumAufloesen(o.bis, heute) || 'ungültig'
  }, { settings, heute, nurZukunft: true });
  if (p.fehler) return frage(p.frage || p.fehler);
  const e = p.eintrag;
  const zeit = e.ganztaegig ? 'ganztägig' : `von ${Z.hhmm(e.beginn)} bis ${Z.hhmm(e.ende)} Uhr`;
  let wann;
  if (e.wiederholung === 'keine') wann = `am ${Z.datumMitJahr(e.datum)}`;
  else if (e.wiederholung === 'taeglich') wann = `jeden Tag ab ${Z.datumMitJahr(e.datum)}`;
  else wann = `jeden ${tageText(e.wochentage)}, erstmals am ${Z.datumMitJahr(e.datum)}`;
  if (e.bis) wann += ` bis ${Z.datumMitJahr(e.bis)}`;
  const text = `Ich trage «${e.titel}» ${wann}, ${zeit}, ein${endeStandard ? ' (Dauer eine Stunde, weil du kein Ende genannt hast)' : ''}. Stimmt das?`;
  return { type: 'termin_anlegen', termin: apiForm(e), bestaetigen: true, text };
}

const PLAN_PROMPT = `- termin_anlegen: Termin oder Block eintragen. Felder: "titel", "typ" (termin, kunde, sport, fokus, pause, privat), "datum" (YYYY-MM-DD, oder heute, morgen, uebermorgen, oder ein Wochentag; weglassen bei wöchentlichen Terminen ohne Startdatum), "beginn" und "ende" (HH:MM, 24 Stunden; "ende" weglassen wenn Lorena keines nennt), "ganztaegig" (true nur wenn sie ganztägig sagt), "wiederholung" (keine, taeglich, woechentlich), "wochentage" (Liste von 1 für Montag bis 7 für Sonntag, nur bei woechentlich), "bis" (YYYY-MM-DD, nur wenn genannt). Erfinde nie Uhrzeiten oder Daten, die Lorena nicht genannt hat. Lass das Feld dann weg.
- ferien_anlegen: Ferien eintragen. Felder: "von" und "bis" (YYYY-MM-DD), optional "titel".
- plan_zeigen: Tagesplan zeigen ("Mach mir den Tagesplan"). Optional "datum".
- plan_neu: Tagesplan neu berechnen.
- termine_zeigen: Termine des Kalenders nennen ("Was habe ich heute?", "Was steht morgen an?") oder freie Zeit nennen ("Wann habe ich Zeit?", modus "zeit"). Felder: optional "datum" (wie bei plan_zeigen), "modus" ("termine" oder "zeit"). Den Inhalt der Termine kennst Du nicht; er wird ausserhalb von Dir eingesetzt.
- naechste_aufgabe: Was als Nächstes dran ist ("Was ist als Nächstes dran?", "Ich habe nur noch zwei Stunden"). Bei einer Zeitangabe "minuten" als ganze Zahl.`;

// ── Antwort aus Kalender und Plan, ohne KI ──
// Die Termine kommen nie in den Auftrag an die KI. Dieser Text entsteht hier aus dem Plan des Tages (nur Titel, Zeit, Ort; keine Beschreibung).
const ohneStriche = (t) => String(t == null ? '' : t).replace(/\s*[–—―]\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
const tagName = (datum, heute) => (datum === heute ? 'Heute' : datum === Z.addTage(heute, 1) ? 'Morgen' : Z.datumLang(datum));
function terminZeile(b) {
  const wo = b.ort ? `, ${ohneStriche(b.ort)}` : '';
  const frei = b.frei ? ' (verfügbar)' : '';
  const was = `«${ohneStriche(b.titel).replace(/[«»]/g, '')}»`;
  return b.ganztaegig ? `ganztägig ${was}${wo}${frei}` : `${Z.hhmm(b.beginn)} bis ${Z.hhmm(b.ende)} Uhr ${was}${wo}${frei}`;
}
// Freie Zeitfenster von mindestens 30 Minuten zwischen Arbeitsbeginn und Fristende, ohne Termine (ausser «verfügbar»), Plan-Aufgaben und Pause
function freieFenster(plan, settings, jetzt, heute) {
  const s = settings || T.STANDARD;
  let von = s.start_normal, bis = s.frist_ende;
  if (plan.datum === heute) von = Math.max(von, Math.ceil(Z.zurich(jetzt).min / 5) * 5);
  const belegt = [];
  for (const b of plan.bloecke || []) if (!b.ganztaegig && !b.frei) belegt.push([b.beginn, b.ende]);
  for (const i of plan.items || []) belegt.push([i.beginn, i.ende]);
  if (plan.mittag) belegt.push([plan.mittag.beginn, plan.mittag.ende]);
  belegt.sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = von;
  for (const [a, b] of belegt) {
    if (a > t && Math.min(a, bis) - t >= 30) out.push([t, Math.min(a, bis)]);
    t = Math.max(t, b);
  }
  if (bis - t >= 30) out.push([t, bis]);
  return out;
}
function termineAntwort(plan, modus, { settings, jetzt = new Date(), heute = Z.heute(jetzt) } = {}) {
  const tag = tagName(plan.datum, heute);
  const bl = (plan.bloecke || []).slice().sort((a, b) => (a.ganztaegig ? -1 : a.beginn) - (b.ganztaegig ? -1 : b.beginn));
  const aufg = (plan.items || []).length;
  const z = [];
  if (modus === 'zeit') {
    if (plan.arbeitstag === false) z.push(`${tag} ist ein freier Tag (${plan.grund}).`);
    const f = freieFenster(plan, settings, jetzt, heute);
    if (!f.length) z.push(`${tag} ist zwischen Arbeitsbeginn und Feierabend keine zusammenhängende freie Zeit von mindestens 30 Minuten übrig.`);
    else z.push(`${tag} hast du Zeit: ${f.slice(0, 6).map(([a, b]) => `${Z.hhmm(a)} bis ${Z.hhmm(b)} Uhr`).join(', ')}.`);
    return ohneStriche(z.join(' ')).slice(0, 700);
  }
  if (plan.arbeitstag === false && !bl.length) z.push(`${tag} ist ein freier Tag (${plan.grund}).`);
  if (!bl.length) z.push(`${tag} hast du keine Termine.`);
  else z.push(`${tag} ${bl.length === 1 ? 'hast du einen Termin' : `hast du ${bl.length} Termine`}: ${bl.slice(0, 12).map(terminZeile).join('; ')}.${bl.length > 12 ? ' Weitere stehen im Kalender.' : ''}`);
  if (aufg) z.push(`Im Plan ${aufg === 1 ? 'steht eine Aufgabe' : `stehen ${aufg} Aufgaben`}, die letzte endet um ${plan.ende} Uhr.`);
  return ohneStriche(z.join(' ')).slice(0, 900);
}

module.exports = { termineAntwort, freieFenster, PLAN_AKTIONEN, PLAN_PROMPT, pruefePlanAktion, datumAufloesen, wochentageLesen };
