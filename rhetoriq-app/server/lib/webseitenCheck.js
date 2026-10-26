// Prüfbibliothek für komplette Webseitentexte (mehrere Webseiten, jeweils viele Seiten).
// Reine Funktionen, keine KI, keine Datenbank. Nutzt lib/lint.js für Floskeln, Gegenüberstellungen und Alleinstellung.
// Eine «Seite» ist {id, site, typ, titel, beschreibung, h1, h2:[], text, faq:[{frage,antwort}]}.

const { lintText } = require('./lint');

const SHINGLE = 5;

// Stoppwörter für die Wiederholungssuche
const STOPP = new Set(('der die das den dem des ein eine einen einem einer eines und oder aber auch nicht nur noch schon sehr ' +
  'ist sind war waren wird werden hat haben hatte kann können man wir ihr sie es er ich du uns euch ihnen ihre ihren ihrem ' +
  'unser unsere unseren unserem unserer in im an am auf aus bei mit nach von vom zu zum zur über unter vor für durch um bis ' +
  'als wie wenn dass weil so dann hier dort da dies diese diesen diesem dieser dieses sich zum').split(' '));

// Floskeln, die in Webseitentexten zusätzlich zu lint.js verboten sind
const FLOSKELN_WEB = [
  /herzlich willkommen/gi,
  /unvergesslich\w*/gi,
  /kulinarische[nrsm]?\s+perlen?/gi,
  /wir freuen uns/gi
];

// ---------- Hilfen ----------

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function woerter(s) {
  const n = norm(s);
  return n ? n.split(' ') : [];
}
function seitenText(s) {
  const faq = (s.faq || []).map(f => `${f.frage || ''}. ${f.antwort || ''}`).join(' ');
  return [s.titel, s.beschreibung, s.h1, (s.h2 || []).join('. '), s.text, faq].filter(Boolean).join('\n');
}
function saetze(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
}

// ---------- Ähnlichkeit ----------

function shingles(text) {
  const w = woerter(text);
  const set = new Set();
  if (!w.length) return set;
  if (w.length < SHINGLE) { set.add(w.join(' ')); return set; }
  for (let i = 0; i + SHINGLE <= w.length; i++) set.add(w.slice(i, i + SHINGLE).join(' '));
  return set;
}
function jaccard(sa, sb) {
  if (!sa.size || !sb.size) return 0;
  const [klein, gross] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let gem = 0;
  for (const x of klein) if (gross.has(x)) gem++;
  return gem / (sa.size + sb.size - gem);
}
function aehnlichkeit(a, b) {
  return jaccard(shingles(a), shingles(b));
}

function gemeinsameSaetze(ta, tb, max = 3) {
  const nb = new Set(saetze(tb).map(norm));
  const out = [];
  for (const s of saetze(ta)) {
    const n = norm(s);
    if (n.split(' ').length >= 6 && nb.has(n) && !out.includes(s)) {
      out.push(s);
      if (out.length >= max) break;
    }
  }
  return out;
}

// Seiten gleichen Typs auf verschiedenen Webseiten und Seiten innerhalb derselben Webseite
function duplikate(seiten, opts = {}) {
  const schwelle = opts.schwelle != null ? opts.schwelle : 0.35;
  const liste = (seiten || []).map(s => ({ s, sh: shingles(seitenText(s)) }));
  const out = [];
  for (let i = 0; i < liste.length; i++) {
    for (let j = i + 1; j < liste.length; j++) {
      const A = liste[i].s, B = liste[j].s;
      if (A.site === B.site ? false : A.typ !== B.typ) continue;
      const a = jaccard(liste[i].sh, liste[j].sh);
      if (a < schwelle) continue;
      out.push({
        a: A.id, b: B.id, siteA: A.site, siteB: B.site, typ: A.typ === B.typ ? A.typ : `${A.typ}/${B.typ}`,
        aehnlichkeit: Math.round(a * 1000) / 1000,
        gemeinsameSaetze: gemeinsameSaetze(seitenText(A), seitenText(B))
      });
    }
  }
  return out.sort((x, y) => y.aehnlichkeit - x.aehnlichkeit);
}

// ---------- Wiederholungen ----------

function wiederholungen(seiten, opts = {}) {
  const laenge = opts.laenge || 4;
  const minSeiten = opts.minSeiten || 3;
  const minSites = opts.minSites || 2;
  const liste = seiten || [];
  // Namen der Webseiten sind keine Wiederholung, sondern Fakten
  const namenWoerter = new Set();
  for (const s of liste) for (const w of woerter(s.site)) namenWoerter.add(w);

  const zaehler = new Map();   // phrase -> {seiten:Set, sites:Set}
  const zaehle = (phrase, s) => {
    let e = zaehler.get(phrase);
    if (!e) zaehler.set(phrase, e = { seiten: new Set(), sites: new Set() });
    e.seiten.add(s.id); e.sites.add(s.site);
  };
  for (const s of liste) {
    const w = woerter(seitenText(s));
    const gesehen = new Set();
    for (let i = 0; i + laenge <= w.length; i++) {
      const teil = w.slice(i, i + laenge);
      const inhalt = teil.filter(x => !STOPP.has(x));
      if (inhalt.length < 2 && !(inhalt.length >= 1 && laenge <= 2)) continue;   // Stoppwort-Folgen
      if (teil.some(x => /\d/.test(x))) continue;                                 // Fakten (Zahlen, Zeiten)
      if (teil.filter(x => namenWoerter.has(x)).length * 2 >= teil.length) continue; // reine Namen
      const phrase = teil.join(' ');
      if (gesehen.has(phrase)) continue;
      gesehen.add(phrase);
      zaehle(phrase, s);
    }
    // bekannte Floskel «herzlich willkommen» zählt unabhängig von der Länge
    const joined = ' ' + w.join(' ') + ' ';
    if (joined.includes(' herzlich willkommen ')) zaehle('herzlich willkommen', s);
  }
  let res = [];
  for (const [phrase, e] of zaehler) {
    if (e.seiten.size >= minSeiten && e.sites.size >= minSites) {
      res.push({ phrase, anzahlSeiten: e.seiten.size, sites: [...e.sites] });
    }
  }
  res.sort((a, b) => b.anzahlSeiten - a.anzahlSeiten || b.phrase.length - a.phrase.length);
  // Verschobene Teilfolgen derselben längeren Wendung zusammenfassen
  const behalten = [];
  for (const r of res) {
    const w = r.phrase.split(' ');
    const doppelt = behalten.some(k => {
      if (k.anzahlSeiten !== r.anzahlSeiten) return false;
      return k.phrase.includes(r.phrase) || r.phrase.includes(k.phrase) ||
        (w.length > 2 && (k.phrase.includes(w.slice(0, -1).join(' ')) || k.phrase.includes(w.slice(1).join(' '))));
    });
    if (!doppelt) behalten.push(r);
  }
  return behalten;
}

// ---------- Fakten ----------

function telNorm(s) {
  let d = String(s || '').replace(/[^\d+]/g, '');
  d = d.replace(/^\+41/, '0').replace(/^0041/, '0').replace(/^\+/, '');
  return d.replace(/^410/, '0');
}
function zeitNorm(h, m) {
  return String(h).padStart(2, '0') + ':' + String(m || '00').padStart(2, '0');
}
function strasseNorm(s) {
  return norm(String(s || '').replace(/ß/g, 'ss').replace(/\bstr\./gi, 'strasse')).replace(/\s+/g, '');
}
function erwarteteZeiten(f) {
  const set = new Set();
  for (const z of (f && f.oeffnungszeiten) || []) {
    const v = /(\d{1,2})[:.]?(\d{2})?/.exec(String(z.von || '')), b = /(\d{1,2})[:.]?(\d{2})?/.exec(String(z.bis || ''));
    if (v && b) set.add(zeitNorm(v[1], v[2]) + '-' + zeitNorm(b[1], b[2]));
  }
  return set;
}

function faktenKonflikte(seiten, faktenProSite) {
  const out = [];
  const gesehen = new Set();
  const melde = (k) => {
    const key = [k.site, k.art, k.gefunden, k.seiteId].join('|');
    if (!gesehen.has(key)) { gesehen.add(key); out.push(k); }
  };
  for (const s of seiten || []) {
    const f = (faktenProSite || {})[s.site];
    if (!f) continue;
    const text = seitenText(s);

    // Telefon
    if (f.telefon) {
      const soll = telNorm(f.telefon);
      const re = /(?:\+41|0041|\b0)[\s\d()\/.\-]{7,18}\d/g;
      let m;
      while ((m = re.exec(text))) {
        const n = telNorm(m[0]);
        if (n.length !== 10 || n.startsWith('00')) continue;   // keine Telefonnummer (Datum, Zahl)
        if (n !== soll) melde({ site: s.site, art: 'telefon', gefunden: m[0].trim(), erwartet: f.telefon, seiteId: s.id });
      }
    }

    // PLZ: gleiche Ortsangabe mit anderer PLZ
    if (f.plz && f.ort) {
      const re = /\b(\d{4})\s+([A-ZÄÖÜ][\p{L}\-]+)/gu;
      let m;
      while ((m = re.exec(text))) {
        if (norm(m[2]) === norm(f.ort).split(' ')[0] && m[1] !== String(f.plz)) {
          melde({ site: s.site, art: 'plz', gefunden: `${m[1]} ${m[2]}`, erwartet: `${f.plz} ${f.ort}`, seiteId: s.id });
        }
      }
    }

    // Strasse und Hausnummer
    if (f.strasse) {
      const sollM = /^(.*?)\s*(\d+\s*[a-zA-Z]?)\s*$/.exec(String(f.strasse));
      const sollName = strasseNorm(sollM ? sollM[1] : f.strasse), sollNr = sollM ? sollM[2].replace(/\s+/g, '').toLowerCase() : '';
      const re = /\b([A-ZÄÖÜ][\p{L}\-]*(?:strasse|straße|str\.|gasse|weg|platz|allee|quai|rain|ring|hof)|(?:[A-ZÄÖÜ][\p{L}\-]*\s)?(?:Strasse|Gasse|Weg|Platz))\s+(\d+\s?[a-zA-Z]?)(?![\p{L}\d])(.{0,20})/gu;
      let m;
      while ((m = re.exec(text))) {
        const name = strasseNorm(m[1]), nr = m[2].replace(/\s+/g, '').toLowerCase();
        const gefunden = `${m[1]} ${m[2]}`.trim();
        if (name === sollName) {
          if (sollNr && nr !== sollNr) melde({ site: s.site, art: 'adresse', gefunden, erwartet: f.strasse, seiteId: s.id });
        } else if (f.plz && new RegExp(`\\b${f.plz}\\b`).test(m[3])) {
          // andere Strasse, gefolgt von der PLZ der Site: gemeint ist vermutlich die eigene Adresse
          melde({ site: s.site, art: 'adresse', gefunden, erwartet: f.strasse, seiteId: s.id });
        }
      }
    }

    // Öffnungszeiten: Zeitspannen, die nicht im Faktenblatt stehen
    const soll = erwarteteZeiten(f);
    if (soll.size) {
      const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:Uhr)?\s*(?:–|—|-|bis)\s*(\d{1,2})(?:[:.](\d{2}))?\s*Uhr|(\d{1,2})[:.](\d{2})\s*(?:–|—|-|bis)\s*(\d{1,2})[:.](\d{2})/g;
      let m;
      while ((m = re.exec(text))) {
        const von = m[1] != null ? zeitNorm(m[1], m[2]) : zeitNorm(m[5], m[6]);
        const bis = m[3] != null ? zeitNorm(m[3], m[4]) : zeitNorm(m[7], m[8]);
        if (+von.slice(0, 2) > 24 || +bis.slice(0, 2) > 24) continue;
        if (!soll.has(von + '-' + bis)) {
          melde({ site: s.site, art: 'zeit', gefunden: m[0].trim(), erwartet: [...soll].join(', '), seiteId: s.id });
        }
      }
    }
  }
  return out;
}

// ---------- Qualität einer Seite ----------

const SUPERLATIV = /\b(?:beste[rsnm]?|schönste[rsnm]?|grösste[rsnm]?|größte[rsnm]?|beliebteste[rsnm]?|einzigartig\w*|unübertroffen\w*)\b/gi;
const BELEG = /\d|ausgezeichnet|auszeichnung|gault|michelin|punkte|preis\b/i;
const NEBENSATZ = /^(?:weil|dass|wenn|ob|als|damit|während|obwohl|sobald|bevor|nachdem|falls|sodass|da|wo|wer|was|wie)\b/i;
const SUBJEKT = /^(?:ich|du|er|sie|es|wir|ihr|man)\s+(?!und\b|oder\b|aber\b)\p{L}+(?:t|en|st|e)\b/iu;

// Heuristik: zwei vollständige Hauptsätze, nur mit Komma verbunden
function kommaVerbunden(text) {
  const out = [];
  for (const satz of saetze(text)) {
    if (NEBENSATZ.test(satz)) continue;
    const re = /,\s+/g;
    let m;
    while ((m = re.exec(satz))) {
      const davor = satz.slice(0, m.index), danach = satz.slice(m.index + m[0].length);
      if (davor.split(/\s+/).length < 3) continue;
      if (/\b(?:der|die|das|welche[rsnm]?|wo|dass|weil|wenn|ob)\s+\p{L}*$/iu.test(davor.slice(-25)) && false) continue;
      if (SUBJEKT.test(danach) && /\p{L}+(?:t|en|st|e)\b/u.test(davor.split(/\s+/).slice(1).join(' '))) {
        out.push(satz.length > 90 ? satz.slice(0, 90) + '...' : satz);
        break;
      }
    }
  }
  return out;
}

function seitenQualitaet(seite, opts = {}) {
  const s = seite || {};
  const ziel = opts.ziel || {};
  const hinweise = [];
  const add = (art, stufe, text) => hinweise.push({ art, stufe, text });

  // H1
  const h1 = String(s.h1 || '').trim();
  const h1Anzahl = Array.isArray(s.h1) ? s.h1.filter(x => String(x).trim()).length : (h1 ? 1 : 0);
  if (h1Anzahl === 0) add('h1', 'fehler', 'Die Seite hat keine H1 oder die H1 ist leer.');
  else if (h1Anzahl > 1) add('h1', 'fehler', 'Die Seite hat mehr als eine H1.');
  const h1Text = Array.isArray(s.h1) ? s.h1.join(' ') : h1;
  if (/<h1[\s>]/i.test(String(s.text || '')) || /^#\s+\S/m.test(String(s.text || ''))) add('h1', 'fehler', 'Im Text steht eine weitere H1.');

  // Titel
  const titel = String(s.titel || '').trim();
  if (!titel) add('titel', 'fehler', 'Der Titel fehlt.');
  else {
    if (titel.length > 60) add('titel', 'fehler', `Der Titel hat ${titel.length} Zeichen, erlaubt sind höchstens 60.`);
    if (/herzlich willkommen\W*$/i.test(titel)) add('titel', 'fehler', 'Der Titel endet auf «Herzlich willkommen».');
  }

  // Beschreibung
  const bes = String(s.beschreibung || '').trim();
  if (!bes) add('beschreibung', 'hinweis', 'Die Beschreibung fehlt.');
  else if (bes.length < 120 || bes.length > 155) add('beschreibung', 'hinweis', `Die Beschreibung hat ${bes.length} Zeichen, gewünscht sind 120 bis 155.`);

  // Wortzahl
  const anzahl = String(s.text || '').split(/\s+/).filter(Boolean).length;
  if (Array.isArray(ziel.laengeWoerter)) {
    const [min, max] = ziel.laengeWoerter;
    if (anzahl < min) add('laenge', 'hinweis', `Der Text hat ${anzahl} Wörter, gewünscht sind mindestens ${min}.`);
    else if (anzahl > max) add('laenge', 'hinweis', `Der Text hat ${anzahl} Wörter, gewünscht sind höchstens ${max}.`);
  }

  const alles = seitenText(s);

  // Platzhalter
  const luecken = [];
  const rePh = /\[([^\]\n]{1,80})\](?!\()/g;
  let m;
  while ((m = rePh.exec(alles))) luecken.push(m[0]);
  if (luecken.length) add('platzhalter', 'fehler', `${luecken.length} Platzhalter in eckigen Klammern sind noch offen.`);

  // Gedankenstriche (der kurze Strich zwischen Zahlen, etwa 11–22 Uhr, bleibt erlaubt)
  const re = /[–—]/g;
  let striche = 0;
  while ((m = re.exec(alles))) {
    const zwischenZahlen = /\d\s?$/.test(alles.slice(0, m.index)) && /^\s?\d/.test(alles.slice(m.index + 1));
    if (m[0] === '–' && zwischenZahlen) continue;
    striche++;
  }
  if (striche) add('gedankenstrich', 'fehler', `${striche} Gedankenstrich${striche === 1 ? '' : 'e'} gefunden. Statt dessen Punkt oder Komma setzen.`);

  // Floskeln (eigene Liste und lint.js)
  const floskeln = new Set();
  for (const r of FLOSKELN_WEB) { const rr = new RegExp(r.source, r.flags); let x; while ((x = rr.exec(alles))) floskeln.add(x[0].toLowerCase()); }
  const lint = lintText(alles, { textart: 'website' });
  for (const h of lint) if (h.art === 'floskel') floskeln.add(h.text.toLowerCase());
  for (const f of floskeln) add('floskel', 'fehler', `Floskel gefunden: «${f}».`);

  // Gegenüberstellungen laut lint.js (Hinweis)
  for (const h of lint) if (h.art === 'gegenueberstellung') add('gegenueberstellung', 'hinweis', `Gegenüberstellung: «${h.kontext}».`);

  // Hauptsätze nur mit Komma verbunden (Heuristik)
  for (const satz of kommaVerbunden(alles)) add('komma', 'hinweis', `Möglicherweise zwei Hauptsätze nur mit Komma verbunden: «${satz}».`);

  // Superlative ohne Beleg
  const belegtFuer = (satz) => BELEG.test(satz);
  for (const satz of saetze(alles)) {
    const r = new RegExp(SUPERLATIV.source, 'gi');
    const x = r.exec(satz);
    if (x && !belegtFuer(satz)) add('superlativ', 'hinweis', `Behauptung ohne Beleg: «${x[0]}».`);
  }
  for (const h of lint) if (h.art === 'alleinstellung' && !hinweise.some(k => k.art === 'superlativ' && k.text.includes(h.text))) {
    add('superlativ', 'hinweis', `Behauptung ohne Beleg: «${h.text}».`);
  }

  // FAQ
  if (ziel.faqNoetig && !(s.faq || []).some(f => f && (f.frage || f.antwort))) add('faq', 'fehler', 'Für diesen Seitentyp fehlt der FAQ-Teil.');

  return { ok: !hinweise.some(h => h.stufe === 'fehler'), hinweise, luecken };
}

// ---------- Gesamtbericht ----------

function zusammenfassung(seiten, optionen = {}) {
  const liste = seiten || [];
  let fehler = 0, hinweise = 0;
  const luecken = new Map();
  const proSeite = [];
  for (const s of liste) {
    const ziel = (optionen.zielProTyp && optionen.zielProTyp[s.typ]) || optionen.ziel || {};
    const q = seitenQualitaet(s, { ziel });
    for (const h of q.hinweise) { if (h.stufe === 'fehler') fehler++; else hinweise++; }
    if (q.luecken.length) {
      if (!luecken.has(s.site)) luecken.set(s.site, []);
      luecken.get(s.site).push({ seiteId: s.id, platzhalter: q.luecken });
    }
    proSeite.push({ id: s.id, site: s.site, typ: s.typ, ok: q.ok, hinweise: q.hinweise });
  }
  return {
    anzahlSeiten: liste.length,
    fehler,
    hinweise,
    duplikate: duplikate(liste, { schwelle: optionen.schwelle }),
    wiederholungen: wiederholungen(liste, optionen.wiederholungen || {}),
    konflikte: faktenKonflikte(liste, optionen.faktenProSite || {}),
    luecken,
    seiten: proSeite
  };
}

module.exports = { aehnlichkeit, duplikate, wiederholungen, faktenKonflikte, seitenQualitaet, zusammenfassung };
