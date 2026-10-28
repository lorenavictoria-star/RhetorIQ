// Strukturiertes Faktenblatt eines Betriebs (Restaurant). Daraus entstehen «Auf einen Blick»,
// schema.org-Strukturdaten und der Faktenteil im KI-Auftrag, alles deterministisch und ohne KI.
// Gespeichert wird als JSON in einheiten.fakten_json.

const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const TAGE_DE = TAGE;
const TAGE_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Beschriftungen der Zeilen: Deutsch (Standard) und English
const LBL = {
  de: { adresse: 'Adresse', telefon: 'Telefon', email: 'E-Mail', webseite: 'Webseite', reservation: 'Reservation', zeiten: 'Öffnungszeiten', ruhetag: 'Ruhetag', kueche: 'Küche', preis: 'Preisklasse', chef: 'Küchenchef', gegruendet: 'Gegründet', innen: 'Plätze innen', terrasseN: 'Plätze Terrasse', terrasse: 'Terrasse', kinder: 'Kinderfreundlich', barriere: 'Barrierefrei', ja: 'ja', nein: 'nein', parkplatz: 'Parkplatz und Anreise', anlaesse: 'Anlässe', besonderheiten: 'Besonderheiten', auszeichnungen: 'Auszeichnungen', bis: 'bis', und: 'und', uhr: ' Uhr' },
  en: { adresse: 'Address', telefon: 'Telephone', email: 'Email', webseite: 'Website', reservation: 'Reservations', zeiten: 'Opening hours', ruhetag: 'Closed', kueche: 'Cuisine', preis: 'Price range', chef: 'Head chef', gegruendet: 'Founded', innen: 'Seats inside', terrasseN: 'Seats on the terrace', terrasse: 'Terrace', kinder: 'Child-friendly', barriere: 'Step-free access', ja: 'yes', nein: 'no', parkplatz: 'Parking and directions', anlaesse: 'Events', besonderheiten: 'Features', auszeichnungen: 'Awards', bis: 'to', und: 'and', uhr: '' }
};
const lbl = opt => (opt && /^en/i.test(String(opt.sprache || ''))) ? LBL.en : LBL.de;
const SCHEMA_TAGE = { Mo: 'Monday', Di: 'Tuesday', Mi: 'Wednesday', Do: 'Thursday', Fr: 'Friday', Sa: 'Saturday', So: 'Sunday' };

const FAKTEN_FELDER = [
  { key: 'strasse', label: 'Strasse und Nummer', typ: 'text', hinweis: 'zum Beispiel Seestrasse 12' },
  { key: 'plz', label: 'PLZ', typ: 'text', hinweis: 'vierstellig' },
  { key: 'ort', label: 'Ort', typ: 'text', hinweis: 'zum Beispiel Luzern' },
  { key: 'telefon', label: 'Telefon', typ: 'text', hinweis: 'zum Beispiel +41 41 123 45 67' },
  { key: 'email', label: 'E-Mail', typ: 'text', hinweis: 'Adresse für Anfragen' },
  { key: 'reservation_url', label: 'Reservation (Link)', typ: 'text', hinweis: 'Link zur Online-Reservation, beginnt mit https://' },
  { key: 'webseite_url', label: 'Webseite', typ: 'text', hinweis: 'beginnt mit https://' },
  { key: 'kueche', label: 'Küche', typ: 'text', hinweis: 'zum Beispiel Saisonale Schweizer Küche' },
  { key: 'preisklasse', label: 'Preisklasse', typ: 'text', hinweis: 'zum Beispiel CHF 30 bis 60 oder $$' },
  { key: 'kapazitaet_innen', label: 'Plätze innen', typ: 'zahl', hinweis: 'Anzahl Sitzplätze' },
  { key: 'kapazitaet_terrasse', label: 'Plätze Terrasse', typ: 'zahl', hinweis: 'Anzahl Sitzplätze' },
  { key: 'terrasse', label: 'Terrasse', typ: 'bool', hinweis: 'ja oder nein' },
  { key: 'kinderfreundlich', label: 'Kinderfreundlich', typ: 'bool', hinweis: 'ja oder nein' },
  { key: 'barrierefrei', label: 'Barrierefrei', typ: 'bool', hinweis: 'ja oder nein' },
  { key: 'parkplatz_anreise', label: 'Parkplatz und Anreise', typ: 'text', hinweis: 'zum Beispiel Parkhaus 200 m, Bus 12 bis Seeblick' },
  { key: 'oeffnungszeiten', label: 'Öffnungszeiten', typ: 'zeiten', hinweis: 'Tage mit Von und Bis; Ruhetage ohne Eintrag lassen' },
  { key: 'besonderheiten', label: 'Besonderheiten', typ: 'liste', hinweis: 'je ein Punkt, zum Beispiel Seesicht' },
  { key: 'auszeichnungen', label: 'Auszeichnungen', typ: 'liste', hinweis: 'je eine Auszeichnung' },
  { key: 'anlaesse', label: 'Anlässe', typ: 'liste', hinweis: 'zum Beispiel Firmenanlass, Hochzeit' },
  { key: 'kuechenchef', label: 'Küchenchef', typ: 'text', hinweis: 'Name' },
  { key: 'gruendungsjahr', label: 'Gründungsjahr', typ: 'zahl', hinweis: 'vierstellig' }
];

const FELD = Object.fromEntries(FAKTEN_FELDER.map(f => [f.key, f]));
const TEXT_MAX = 300, LISTE_MAX = 20, ITEM_MAX = 120, URL_MAX = 500, BEM_MAX = 120, ZEILEN_MAX = 14;

// Gedankenstriche kommen in keiner Ausgabe vor
const ohneStriche = s => String(s).replace(/\s*[–—]\s*/g, '-');
const putz = (v, max) => ohneStriche(String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);

function istUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}
function zeit(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return String(h).padStart(2, '0') + ':' + m[2];
}
const bool = v => (v === true || v === 'true' || v === 'ja' || v === 1) ? true : (v === false || v === 'false' || v === 'nein' || v === 0) ? false : undefined;

// Bereinigt und prüft das Faktenblatt. Wirft nie. Ungültige Felder fallen weg und erscheinen in fehler.
function normalisiere(fakten) {
  const out = {}, fehler = [];
  const src = fakten && typeof fakten === 'object' && !Array.isArray(fakten) ? fakten : {};
  for (const f of FAKTEN_FELDER) {
    const v = src[f.key];
    if (v === undefined || v === null || v === '') continue;
    try {
      if (f.typ === 'text') {
        if (typeof v !== 'string' && typeof v !== 'number') { fehler.push(f.label + ': Bitte Text eintragen.'); continue; }
        const t = putz(v, f.key.endsWith('_url') ? URL_MAX : TEXT_MAX);
        if (!t) continue;
        if (f.key === 'plz' && !/^\d{4}$/.test(t)) { fehler.push('PLZ: Bitte eine vierstellige Postleitzahl eintragen.'); continue; }
        if (f.key.endsWith('_url') && !istUrl(t)) { fehler.push(f.label + ': Der Link muss mit http:// oder https:// beginnen.'); continue; }
        if (f.key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { fehler.push('E-Mail: Bitte eine gültige Adresse eintragen.'); continue; }
        out[f.key] = t;
      } else if (f.typ === 'zahl') {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (!Number.isInteger(n) || n < 0 || n > 100000) { fehler.push(f.label + ': Bitte eine ganze Zahl eintragen.'); continue; }
        if (f.key === 'gruendungsjahr' && (n < 1000 || n > 2100)) { fehler.push('Gründungsjahr: Bitte ein vierstelliges Jahr eintragen.'); continue; }
        out[f.key] = n;
      } else if (f.typ === 'bool') {
        const b = bool(v);
        if (b === undefined) { fehler.push(f.label + ': Bitte ja oder nein wählen.'); continue; }
        out[f.key] = b;
      } else if (f.typ === 'liste') {
        const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n|;/) : null;
        if (!arr) { fehler.push(f.label + ': Bitte eine Liste eintragen.'); continue; }
        const l = [...new Set(arr.filter(x => typeof x === 'string').map(x => putz(x, ITEM_MAX)).filter(Boolean))].slice(0, LISTE_MAX);
        if (l.length) out[f.key] = l;
      } else if (f.typ === 'zeiten') {
        if (!Array.isArray(v)) { fehler.push(f.label + ': Bitte die Zeiten als Liste angeben.'); continue; }
        const z = [];
        for (const r of v.slice(0, ZEILEN_MAX)) {
          const tage = r && Array.isArray(r.tage) ? TAGE.filter(t => r.tage.includes(t)) : [];
          const von = r && zeit(r.von), bis = r && zeit(r.bis);
          if (!tage.length) { fehler.push('Öffnungszeiten: Jede Zeile braucht mindestens einen Tag (Mo, Di, Mi, Do, Fr, Sa, So).'); continue; }
          if (!von || !bis) { fehler.push('Öffnungszeiten: Uhrzeiten bitte als HH:MM eintragen, zum Beispiel 11:00.'); continue; }
          const e = { tage, von, bis };
          const bem = r.bemerkung ? putz(r.bemerkung, BEM_MAX) : '';
          if (bem) e.bemerkung = bem;
          z.push(e);
        }
        if (z.length) out[f.key] = z;
      }
    } catch (e) { fehler.push(f.label + ': ungültig.'); }
  }
  return { fakten: out, fehler };
}

const vorhanden = v => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length);
const ladeFakten = f => normalisiere(f).fakten;

// Tage lesbar: «Di bis So», «Mo und Di», «Mo, Mi und Fr»
function tageText(tage, en) {
  const L = en ? LBL.en : LBL.de;
  const TAGE = en ? TAGE_EN : TAGE_DE;
  const idx = TAGE_DE.map((t, i) => tage.includes(t) ? i : -1).filter(i => i >= 0);
  const runs = [];
  for (const i of idx) {
    const l = runs[runs.length - 1];
    if (l && l[l.length - 1] === i - 1) l.push(i); else runs.push([i]);
  }
  const teile = runs.map(r => r.length >= 3 ? TAGE[r[0]] + ' ' + L.bis + ' ' + TAGE[r[r.length - 1]] : r.map(i => TAGE[i]).join(' ' + L.und + ' '));
  const alle = runs.length === 1 && runs[0].length >= 3 ? teile : runs.flatMap(r => r.length >= 3 ? [TAGE[r[0]] + ' ' + L.bis + ' ' + TAGE[r[r.length - 1]]] : r.map(i => TAGE[i]));
  if (alle.length <= 1) return alle[0] || '';
  return alle.slice(0, -1).join(', ') + ' ' + L.und + ' ' + alle[alle.length - 1];
}
function zeitenText(zeiten, en) {
  const L = en ? LBL.en : LBL.de;
  return zeiten.map(z => tageText(z.tage, en) + ' ' + z.von + ' ' + L.bis + ' ' + z.bis + L.uhr + (z.bemerkung ? ' (' + z.bemerkung + ')' : '')).join(', ');
}
function ruhetage(zeiten, en) {
  const offen = new Set(zeiten.flatMap(z => z.tage));
  const zu = TAGE_DE.filter(t => !offen.has(t));
  const r = zu.length && zu.length < 7 ? zu : [];
  return en ? r.map(t => TAGE_EN[TAGE_DE.indexOf(t)]) : r;
}
const adresse = f => [f.strasse, [f.plz, f.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// Zeilen für «Auf einen Blick» in fester Reihenfolge, rein deterministisch
function aufEinenBlick(einheit, fakten, opt) {
  const L = lbl(opt), en = L === LBL.en;
  const f = ladeFakten(fakten);
  const e = einheit || {};
  const z = [];
  const adr = adresse(f) || (e.ort ? String(e.ort) : '');
  if (adr) z.push({ label: L.adresse, wert: adr });
  if (f.telefon) z.push({ label: L.telefon, wert: f.telefon });
  if (f.oeffnungszeiten) {
    let w = zeitenText(f.oeffnungszeiten, en);
    const rt = ruhetage(f.oeffnungszeiten, en);
    if (rt.length) w += '. ' + L.ruhetag + ': ' + rt.join(', ');
    z.push({ label: L.zeiten, wert: w });
  }
  if (f.kueche) z.push({ label: L.kueche, wert: f.kueche });
  if (f.reservation_url) z.push({ label: L.reservation, wert: f.reservation_url });
  if (f.besonderheiten) z.push({ label: L.besonderheiten, wert: f.besonderheiten.join(', ') });
  return z.map(r => ({ label: r.label, wert: ohneStriche(r.wert) }));
}

// schema.org-Strukturdaten als JSON-String. Nur vorhandene Angaben, nichts erfunden.
function jsonLd(einheit, fakten, opt) {
  const L = lbl(opt);
  const f = ladeFakten(fakten);
  const e = einheit || {};
  const r = { '@type': 'Restaurant' };
  if (e.name) r.name = String(e.name);
  const addr = { '@type': 'PostalAddress', addressCountry: 'CH' };
  if (f.strasse) addr.streetAddress = f.strasse;
  if (f.plz) addr.postalCode = f.plz;
  const ort = f.ort || e.ort;
  if (ort) addr.addressLocality = String(ort);
  r.address = addr;
  if (f.telefon) r.telephone = f.telefon;
  if (f.email) r.email = f.email;
  if (f.kueche) r.servesCuisine = f.kueche;
  if (f.preisklasse) r.priceRange = f.preisklasse;
  if (f.webseite_url) r.url = f.webseite_url;
  if (f.reservation_url) r.acceptsReservations = f.reservation_url;
  if (f.kapazitaet_innen || f.kapazitaet_terrasse) r.maximumAttendeeCapacity = (f.kapazitaet_innen || 0) + (f.kapazitaet_terrasse || 0);
  if (f.gruendungsjahr) r.foundingDate = String(f.gruendungsjahr);
  if (f.kuechenchef) r.employee = { '@type': 'Person', name: f.kuechenchef, jobTitle: L.chef };
  if (f.oeffnungszeiten) {
    r.openingHoursSpecification = f.oeffnungszeiten.map(o => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: o.tage.map(t => SCHEMA_TAGE[t]),
      opens: o.von,
      closes: o.bis
    }));
  }
  const am = [];
  for (const [k, n] of [['terrasse', L.terrasse], ['kinderfreundlich', L.kinder], ['barrierefrei', L.barriere]]) {
    if (typeof f[k] === 'boolean') am.push({ '@type': 'LocationFeatureSpecification', name: n, value: f[k] });
  }
  if (am.length) r.amenityFeature = am;
  const graph = [Object.assign({ '@context': 'https://schema.org' }, r)];
  const faq = opt && Array.isArray(opt.faq) ? opt.faq.filter(q => q && typeof q.frage === 'string' && q.frage.trim() && typeof q.antwort === 'string' && q.antwort.trim()) : [];
  if (faq.length) {
    graph.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(q => ({ '@type': 'Question', name: q.frage.trim(), acceptedAnswer: { '@type': 'Answer', text: q.antwort.trim() } }))
    });
  }
  return JSON.stringify(graph.length === 1 ? graph[0] : graph, null, 2);
}

const STANDARD_PFLICHT = ['strasse', 'plz', 'ort', 'telefon', 'oeffnungszeiten', 'kueche', 'reservation_url'];
function fehlendeFakten(fakten, pflichtKeys) {
  const f = ladeFakten(fakten);
  return (Array.isArray(pflichtKeys) ? pflichtKeys : STANDARD_PFLICHT)
    .filter(k => FELD[k] && !vorhanden(f[k]))
    .map(k => ({ key: k, label: FELD[k].label }));
}

// Kompakter Text für den KI-Auftrag (Deutsch, oder English bei opt.sprache)
function faktenText(einheit, fakten, opt) {
  const L = lbl(opt), en = L === LBL.en;
  const f = ladeFakten(fakten);
  const zeilen = [];
  const add = (l, w) => { if (w) zeilen.push(l + ': ' + w); };
  add(L.adresse, adresse(f));
  add(L.telefon, f.telefon);
  add(L.email, f.email);
  add(L.webseite, f.webseite_url);
  add(L.reservation, f.reservation_url);
  if (f.oeffnungszeiten) {
    let w = zeitenText(f.oeffnungszeiten, en);
    const rt = ruhetage(f.oeffnungszeiten, en);
    if (rt.length) w += '. ' + L.ruhetag + ': ' + rt.join(', ');
    add(L.zeiten, w);
  }
  add(L.kueche, f.kueche);
  add(L.preis, f.preisklasse);
  add(L.chef, f.kuechenchef);
  if (f.gruendungsjahr) add(L.gegruendet, String(f.gruendungsjahr));
  if (f.kapazitaet_innen) add(L.innen, String(f.kapazitaet_innen));
  if (f.kapazitaet_terrasse) add(L.terrasseN, String(f.kapazitaet_terrasse));
  for (const [k, n] of [['terrasse', L.terrasse], ['kinderfreundlich', L.kinder], ['barrierefrei', L.barriere]]) {
    if (typeof f[k] === 'boolean') add(n, f[k] ? L.ja : L.nein);
  }
  add(L.parkplatz, f.parkplatz_anreise);
  if (f.anlaesse) add(L.anlaesse, f.anlaesse.join(', '));
  if (f.besonderheiten) add(L.besonderheiten, f.besonderheiten.join(', '));
  if (f.auszeichnungen) add(L.auszeichnungen, f.auszeichnungen.join(', '));
  return zeilen.join('\n');
}

module.exports = { FAKTEN_FELDER, normalisiere, aufEinenBlick, jsonLd, fehlendeFakten, faktenText };
