// Tagesplan der Beraterin: Fristen, Arbeitszeit, Termine, Reihenfolge. Reine Berechnung ohne Datenbank und ohne KI.
// Alle Uhrzeiten sind Minuten ab Mitternacht in Europe/Zurich, Daten 'YYYY-MM-DD'.
const Z = require('./zeit');

const RANG = { enterprise: 4, business: 3, team: 2, stimme: 1 };
const PAKET_NAME = { enterprise: 'Enterprise', business: 'Business', team: 'Team', stimme: 'Stimme' };
const TYP_REIHE = { anfrage: 0, onboarding: 1, auswertung: 2, themenplan: 3, quartalsreview: 4 };
const TYP_NAME = { freigabe: 'Freigabe', anfrage: 'Anfrage', onboarding: 'Onboarding-Entwurf', auswertung: 'Quartalsauswertung', themenplan: 'Themenplan', quartalsreview: 'Quartalsreview' };

const EINGEBAUTE_TYPEN = [
  { key: 'termin', name: 'Termin', farbe: '#3b6fb6' }, { key: 'kunde', name: 'Kundentermin', farbe: '#7a4fb0' },
  { key: 'sport', name: 'Sport', farbe: '#2f8f5b' }, { key: 'fokus', name: 'Fokuszeit', farbe: '#c0762b' },
  { key: 'pause', name: 'Pause', farbe: '#8a8f98' }, { key: 'privat', name: 'Privat', farbe: '#b0517a' },
  { key: 'ferien', name: 'Ferien', farbe: '#d4a017' }, { key: 'feiertag', name: 'Feiertag', farbe: '#a8392c' }
];
const ARBEITSFREI = ['ferien', 'feiertag'];

const STANDARD = {
  start_normal: 480, start_frueh: 450, mittag_von: 720, mittag_bis: 720, // Pause plant der Plan nicht selbst; die Beraterin setzt den Baustein Pause. Bis grösser als von ergibt eine feste Pause.
  frist_stunden: 3, frist_beginn: 480, frist_ende: 1080, stimme_frist: 1020,
  dauer: { freigabe: 20, newsletter: 30, anfrage: 15, onboarding: 30, auswertung: 20, themenplan: 30, quartalsreview: 60 },
  typen: [] // eigene Typen und Farbänderungen: [{ key, name, farbe }]
};
const FARBE = /^#[0-9a-fA-F]{6}$/;

function einstellungen(roh) {
  const o = roh && typeof roh === 'object' ? roh : {};
  const s = JSON.parse(JSON.stringify(STANDARD));
  for (const k of ['start_normal', 'start_frueh', 'mittag_von', 'mittag_bis', 'frist_beginn', 'frist_ende', 'stimme_frist']) {
    if (Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= 1440) s[k] = o[k];
  }
  if (Number.isInteger(o.frist_stunden) && o.frist_stunden >= 1 && o.frist_stunden <= 24) s.frist_stunden = o.frist_stunden;
  if (o.dauer && typeof o.dauer === 'object') {
    for (const k of Object.keys(s.dauer)) if (Number.isInteger(o.dauer[k]) && o.dauer[k] >= 5 && o.dauer[k] <= 480) s.dauer[k] = o.dauer[k];
  }
  if (Array.isArray(o.typen)) {
    const gesehen = new Set();
    for (const t of o.typen.slice(0, 30)) {
      if (!t || typeof t.key !== 'string' || !/^[a-z0-9_]{1,24}$/.test(t.key) || gesehen.has(t.key)) continue;
      if (!FARBE.test(String(t.farbe || ''))) continue;
      const eingebaut = EINGEBAUTE_TYPEN.find(e => e.key === t.key);
      const name = String(t.name || (eingebaut && eingebaut.name) || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 30);
      if (!name) continue;
      gesehen.add(t.key);
      s.typen.push({ key: t.key, name, farbe: t.farbe.toLowerCase() });
    }
  }
  return s;
}
function alleTypen(s) {
  const out = EINGEBAUTE_TYPEN.map(e => ({ ...e, eingebaut: true }));
  for (const t of (s && s.typen) || []) {
    const i = out.findIndex(e => e.key === t.key);
    if (i >= 0) out[i] = { ...out[i], farbe: t.farbe, name: out[i].eingebaut && ARBEITSFREI.includes(t.key) ? out[i].name : t.name };
    else out.push({ ...t, eingebaut: false });
  }
  return out;
}

// ── Einträge (Termine, Blöcke, Ferien, Feiertage) ──
function bereinigeText(t, max) {
  return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s*[–—―]\s*/g, ', ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}
// Prüft einen Eintrag streng. Liefert { eintrag } oder { fehler }.
function eintragPruefen(inp, { settings, heute, nurZukunft = false } = {}) {
  const s = settings || STANDARD;
  const i = inp && typeof inp === 'object' ? inp : {};
  const typen = alleTypen(s).map(t => t.key);
  const typ = typeof i.typ === 'string' && typen.includes(i.typ) ? i.typ : (i.typ == null || i.typ === '' ? 'termin' : null);
  if (!typ) return { fehler: 'Dieser Typ ist unbekannt.' };
  const titel = bereinigeText(i.titel, 80);
  if (!titel) return { fehler: 'Bitte gib einen Titel an.', frage: 'Wie soll der Eintrag heissen?' };
  if (!Z.istDatum(i.datum)) return { fehler: 'Das Datum ist ungültig.', frage: 'Für welchen Tag?' };
  if (nurZukunft && heute && i.datum < heute) return { fehler: 'Das Datum liegt in der Vergangenheit.', frage: 'Dieses Datum liegt schon hinter uns. Welchen Tag meinst du?' };
  const ganztaegig = ARBEITSFREI.includes(typ) ? true : i.ganztaegig === true;
  let beginn = null, ende = null;
  if (!ganztaegig) {
    beginn = Z.zeitZuMin(i.beginn); ende = Z.zeitZuMin(i.ende);
    if (beginn == null) return { fehler: 'Der Beginn fehlt oder ist ungültig.', frage: 'Um wie viel Uhr beginnt es?' };
    if (ende == null) return { fehler: 'Das Ende fehlt oder ist ungültig.', frage: 'Bis wann dauert es?' };
    if (beginn >= 1440 || ende > 1440 || ende <= beginn) return { fehler: 'Das Ende muss nach dem Beginn liegen.', frage: 'Das Ende liegt nicht nach dem Beginn. Wann soll es enden?' };
  }
  const wh = i.wiederholung == null || i.wiederholung === '' ? 'keine' : i.wiederholung;
  if (!['keine', 'taeglich', 'woechentlich'].includes(wh)) return { fehler: 'Die Wiederholung ist ungültig.' };
  let tage = [];
  if (wh === 'woechentlich') {
    const roh = Array.isArray(i.wochentage) ? i.wochentage : [];
    tage = [...new Set(roh.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= 7).sort();
    if (roh.length && tage.length !== new Set(roh.map(Number)).size) return { fehler: 'Die Wochentage sind ungültig.', frage: 'Welche Wochentage meinst du?' };
    if (!tage.length) tage = [Z.wd(i.datum)];
  }
  let bis = null;
  if (i.bis != null && i.bis !== '') {
    if (!Z.istDatum(i.bis)) return { fehler: 'Das Enddatum ist ungültig.', frage: 'Bis wann soll es gelten?' };
    if (i.bis < i.datum) return { fehler: 'Das Enddatum liegt vor dem Beginn.', frage: 'Das Enddatum liegt vor dem Beginn. Bis wann soll es gelten?' };
    if (Z.tageZwischen(i.datum, i.bis) > 366 * 5) return { fehler: 'Das Enddatum liegt zu weit in der Zukunft.' };
    bis = i.bis;
  }
  if (wh === 'keine') bis = null;
  return { eintrag: { titel, typ, datum: i.datum, beginn, ende, ganztaegig, wiederholung: wh, wochentage: tage, bis, notiz: bereinigeText(i.notiz, 500) } };
}

// Alle Vorkommen eines Eintrags an einem Datum
function vorkommen(e, datum) {
  if (datum < e.datum) return false;
  if (Array.isArray(e.ausnahmen) && e.ausnahmen.includes(datum)) return false;
  if (e.wiederholung === 'keine') return datum === e.datum;
  if (e.bis && datum > e.bis) return false;
  if (e.wiederholung === 'taeglich') return true;
  const tage = Array.isArray(e.wochentage) ? e.wochentage : String(e.wochentage || '').split(',').map(Number);
  return tage.includes(Z.wd(datum));
}
function eintraegeAm(eintraege, datum) {
  return (eintraege || []).filter(e => vorkommen(e, datum)).map(e => ({
    id: e.id, titel: e.titel, typ: e.typ, datum, beginn: e.ganztaegig ? null : e.beginn, ende: e.ganztaegig ? null : e.ende,
    ganztaegig: !!e.ganztaegig, notiz: e.notiz || '', wiederholung: e.wiederholung, serie: e.wiederholung !== 'keine',
    ...(e.fremd ? { fremd: true, farbe: e.farbe, quelle: e.quelle } : {})
  })).sort((a, b) => (a.beginn == null ? -1 : a.beginn) - (b.beginn == null ? -1 : b.beginn));
}

// Arbeitstag: Montag bis Freitag, kein Standard-Feiertag, kein eigener Feiertag, keine Ferien
function arbeitstag(datum, eintraege) {
  if (Z.wd(datum) >= 6) return { ja: false, grund: Z.wd(datum) === 6 ? 'Samstag' : 'Sonntag' };
  const f = Z.feiertagName(datum);
  if (f) return { ja: false, grund: f };
  for (const e of eintraegeAm(eintraege, datum)) {
    if (e.typ === 'feiertag') return { ja: false, grund: e.titel };
    if (e.typ === 'ferien') return { ja: false, grund: e.titel || 'Ferien' };
  }
  return { ja: true, grund: null };
}

// ── Fristen ──
function naechsterArbeitstag(datum, eintraege, nach = true) {
  let d = nach ? Z.addTage(datum, 1) : datum;
  for (let n = 0; n < 400; n++) { if (arbeitstag(d, eintraege).ja) return d; d = Z.addTage(d, 1); }
  return d;
}
// Frist einer Freigabe. Stimme: nächster Werktag zur eingestellten Zeit. Sonst Stunden, die nur an Werktagen
// zwischen Fristbeginn und Fristende laufen (Mittagspause zählt nicht ab).
function fristBerechnen(eingang, paket, eintraege, settings) {
  const s = settings || STANDARD;
  const z = Z.zurich(eingang);
  if (paket === 'stimme') return Z.zuDate(naechsterArbeitstag(z.datum, eintraege), s.stimme_frist);
  let tag = z.datum, t = z.min, rest = s.frist_stunden * 60;
  if (!arbeitstag(tag, eintraege).ja) { tag = naechsterArbeitstag(tag, eintraege, false); t = s.frist_beginn; }
  else if (t >= s.frist_ende) { tag = naechsterArbeitstag(tag, eintraege); t = s.frist_beginn; }
  else if (t < s.frist_beginn) t = s.frist_beginn;
  for (let n = 0; n < 400; n++) {
    const frei = s.frist_ende - t;
    if (rest <= frei) return Z.zuDate(tag, t + rest);
    rest -= Math.max(0, frei);
    tag = naechsterArbeitstag(tag, eintraege); t = s.frist_beginn;
  }
  return Z.zuDate(tag, t);
}

// ── Plan ──
const auf5 = (m) => Math.ceil(m / 5) * 5;
function fristText(frist, datum) {
  if (!frist) return null;
  const z = Z.zurich(frist);
  const tag = z.datum === datum ? 'heute' : Z.datumLang(z.datum);
  return `${tag}, ${Z.hhmm(z.min)} Uhr`;
}

// aufgaben: [{ key, typ, klientId, klient, textart, paket, eingang (Date), dringlich, dauer, dauerQuelle, link, reviewId }]
// positionen: { [key]: { datum, beginn } } (von Hand verschoben)
// opts: { datum, eintraege, settings, jetzt, positionen }
function planBauen(aufgaben, opts) {
  const s = opts.settings || STANDARD;
  const datum = opts.datum;
  const jetzt = opts.jetzt || new Date();
  const eintraege = opts.eintraege || [];
  const positionen = opts.positionen || {};
  const at = arbeitstag(datum, eintraege);
  const heuteStr = Z.heute(jetzt);
  const refStart = Z.zuDate(datum, s.start_normal);

  const alle = (aufgaben || []).map(a => {
    const paket = RANG[a.paket] ? a.paket : (a.paket == null ? null : 'team');
    const frist = a.frist ? new Date(a.frist) : (a.eingang && paket ? fristBerechnen(new Date(a.eingang), paket, eintraege, s) : null);
    const pos = positionen[a.key];
    const dauerPos = pos && pos.datum === datum && pos.dauer ? pos.dauer : null; // am Handy geänderte Dauer
    return { ...a, paket, frist, dauer: Math.max(5, Math.min(480, Math.round(dauerPos || a.dauer || s.dauer.freigabe))) };
  });
  const jetztMs = Math.max(jetzt.getTime(), refStart.getTime());
  for (const a of alle) {
    a.ueberfaellig = !!a.frist && a.frist.getTime() < jetztMs;
    a.enterprise = a.paket === 'enterprise';
    a.dringend = !!a.dringlich || a.enterprise || a.ueberfaellig || (!!a.frist && a.frist.getTime() < refStart.getTime() + 90 * 60000);
    a.zwingend = !!a.dringlich || a.enterprise; // dürfen auch an freien Tagen geplant werden
  }
  const fixiert = alle.filter(a => positionen[a.key] && positionen[a.key].datum === datum);
  const frei = alle.filter(a => !fixiert.includes(a));
  const kandidaten = at.ja ? frei : frei.filter(a => a.zwingend);

  const hinweise = [];
  const bloecke = eintraegeAm(eintraege, datum);
  const zeitBloecke = bloecke.filter(b => !b.ganztaegig);
  const startFrueh = kandidaten.concat(fixiert).some(a => a.dringend);
  let start = startFrueh ? s.start_frueh : s.start_normal;
  if (!at.ja && !kandidaten.length && !fixiert.length) {
    return { datum, arbeitstag: false, grund: at.grund, leer: true, start: null, ende: null, items: [], bloecke, mittag: null, fruehStart: false, hinweise: [`${Z.datumLang(datum)} ist ein freier Tag (${at.grund}). Kein Plan.`], ueberfaellig: 0, verspaetet: 0 };
  }

  const belegt = zeitBloecke.map(b => ({ von: b.beginn, bis: b.ende }));
  const mittag = s.mittag_bis > s.mittag_von ? { von: s.mittag_von, bis: s.mittag_bis } : null;
  if (mittag) belegt.push(mittag);
  for (const f of fixiert) {
    const p = positionen[f.key];
    belegt.push({ von: p.beginn, bis: Math.min(1440, p.beginn + f.dauer) });
  }
  const naechsteBelegung = (t, dauer) => {
    let hit = null;
    for (const b of belegt) if (b.von < t + dauer && b.bis > t && (!hit || b.bis > hit.bis)) hit = b;
    return hit;
  };
  const platziere = (t, dauer) => {
    for (let n = 0; n < 500; n++) { const h = naechsteBelegung(t, dauer); if (!h) return t; t = h.bis; }
    return t;
  };

  let cursor = start;
  if (datum === heuteStr) cursor = Math.max(cursor, auf5(Z.zurich(jetzt).min));
  else if (datum < heuteStr) hinweise.push('Dieser Tag liegt in der Vergangenheit.');

  const gruppe = (a) => (a.ueberfaellig ? 0 : (a.dringlich || (a.enterprise && !a.frist)) ? 1 : a.frist ? 2 : 3);
  const fm = (a) => (a.frist ? Math.floor(a.frist.getTime() / 60000) : Infinity);
  const rang = (a) => RANG[a.paket] || 0;
  const reihe = [...kandidaten].sort((a, b) => {
    const ga = gruppe(a), gb = gruppe(b);
    if (ga !== gb) return ga - gb;
    if (ga === 3) return (TYP_REIHE[a.typ] ?? 9) - (TYP_REIHE[b.typ] ?? 9) || rang(b) - rang(a) || a.dauer - b.dauer;
    return fm(a) - fm(b) || rang(b) - rang(a) || a.dauer - b.dauer;
  });

  const platziert = [];
  const offen = [...reihe];
  while (offen.length) {
    const a = offen[0];
    let t = platziere(cursor, a.dauer);
    if (t > cursor) {
      // Lücke vor einem Block: Aufgaben ohne Frist dürfen sie füllen
      const fuell = offen.slice(1).find(x => !x.frist && !x.zwingend && platziere(cursor, x.dauer) === cursor);
      if (fuell) { platziert.push({ a: fuell, von: cursor }); cursor += fuell.dauer; offen.splice(offen.indexOf(fuell), 1); continue; }
    }
    platziert.push({ a, von: t }); cursor = t + a.dauer; offen.shift();
  }
  for (const f of fixiert) platziert.push({ a: f, von: positionen[f.key].beginn, fix: true });
  platziert.sort((x, y) => x.von - y.von);

  let verspaetet = 0, ueberf = 0;
  const items = platziert.map(({ a, von, fix }) => {
    const bis = Math.min(1440, von + a.dauer);
    const ende = Z.zuDate(datum, bis);
    const spaet = !!a.frist && ende.getTime() > a.frist.getTime();
    if (spaet) verspaetet++;
    if (a.ueberfaellig) ueberf++;
    return {
      key: a.key, typ: a.typ, klientId: a.klientId || null, klient: a.klient || '', textart: a.textart || '', paket: a.paket, paketName: a.paket ? PAKET_NAME[a.paket] : null,
      beginn: von, ende: bis, start: Z.hhmm(von), endeText: Z.hhmm(bis), dauer: a.dauer, dauerQuelle: a.dauerQuelle || 'standard',
      frist: a.frist ? a.frist.toISOString() : null, fristText: fristText(a.frist, datum), ueberfaellig: a.ueberfaellig, verspaetet: spaet,
      dringlich: !!a.dringlich, enterprise: a.enterprise, fixiert: !!fix, reviewId: a.reviewId || null, link: a.link || null,
      titel: a.klient ? `${a.klient}, ${a.textart || TYP_NAME[a.typ] || ''}`.replace(/, $/, '') : (a.textart || TYP_NAME[a.typ] || a.typ)
    };
  });
  const ende = items.length ? Math.max(...items.map(i => i.ende)) : null;
  if (!at.ja) hinweise.push(`${Z.datumLang(datum)} ist ein freier Tag (${at.grund}). Es stehen nur dringliche Aufgaben und Enterprise im Plan.`);
  if (startFrueh && at.ja) hinweise.push(`Beginn ${Z.hhmm(s.start_frueh)} Uhr, weil Dringliches ansteht.`);
  if (verspaetet) hinweise.push(verspaetet === 1 ? 'Eine Aufgabe hält ihre Frist nicht mehr.' : `${verspaetet} Aufgaben halten ihre Frist nicht mehr.`);
  return {
    datum, arbeitstag: at.ja, grund: at.grund, leer: !items.length, start: items.length ? Z.hhmm(Math.min(start, ...items.map(i => i.beginn))) : Z.hhmm(start), ende: ende == null ? null : Z.hhmm(ende), fruehStart: startFrueh,
    items, bloecke, mittag: mittag ? { beginn: mittag.von, ende: mittag.bis } : null, hinweise, ueberfaellig: ueberf, verspaetet
  };
}

function dauerText(m) { return m >= 60 ? `${Math.floor(m / 60)} Std.${m % 60 ? ' ' + (m % 60) + ' Min.' : ''}` : `${m} Min.`; }

// Mail und Chat: Reihenfolge mit Zeiten (ohne Gedankenstriche)
function planText(plan) {
  const z = [];
  if (plan.leer) return (plan.hinweise[0] || 'Heute steht nichts im Plan.');
  for (const i of plan.items) {
    z.push(`${i.start} bis ${i.endeText} Uhr  ${i.titel} (${dauerText(i.dauer)})${i.verspaetet ? ', Frist wird nicht gehalten' : ''}${i.ueberfaellig ? ', überfällig' : ''}${i.dringlich ? ', dringlich' : ''}`);
  }
  z.push('');
  z.push(`Voraussichtliches Ende: ${plan.ende} Uhr.`);
  for (const h of plan.hinweise) z.push(h);
  return z.join('\n').replace(/\s*[–—―]\s*/g, ', ');
}
function naechste(plan, jetzt, minuten) {
  const nowMin = Z.zurich(jetzt).datum === plan.datum ? Z.zurich(jetzt).min : 0;
  const rest = plan.items.filter(i => i.ende > nowMin);
  const dran = rest[0] || null;
  let passt = [];
  if (minuten) { let sum = 0; for (const i of rest) { if (sum + i.dauer > minuten) continue; passt.push(i); sum += i.dauer; } }
  return { dran, passt, gesamt: passt.reduce((x, i) => x + i.dauer, 0) };
}

module.exports = { RANG, PAKET_NAME, TYP_NAME, EINGEBAUTE_TYPEN, ARBEITSFREI, STANDARD, einstellungen, alleTypen, eintragPruefen, vorkommen, eintraegeAm, arbeitstag, naechsterArbeitstag, fristBerechnen, planBauen, planText, naechste, dauerText, bereinigeText };
