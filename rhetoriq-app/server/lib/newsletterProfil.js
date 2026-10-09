// Newsletter-Stilprofil eines Klienten. Die Eckdaten werden per Programm aus den früheren Newslettern berechnet, nicht von der KI geschätzt.
// Quellen (Vorrang in dieser Reihenfolge): 1. freigegebene und von der Beraterin korrigierte Fassungen (review_requests, edited_text),
// 2. Newsletter-Beispiele aus der Beispielablage des Klienten (module_examples mit source_client_id), 3. frühere erzeugte Newsletter (analyses).
// Bei weniger als zwei Newslettern gibt es kein Profil: Der Prompt sagt das klar und fällt auf die Brand Voice zurück.
const { pool } = require('../db');
const { fence } = require('./dataFence');
const { zerlege, bloecke } = require('./newsletterHtml');

const MIN_NEWSLETTER = 2;      // darunter kein Profil
const MAX_QUELLE = 20;
const MIN_ZEICHEN = 150;       // kürzere Texte sind keine Newsletter
const BEISPIEL_ZEICHEN = 1800; // je Few-Shot-Beispiel
const STANDARD = { woerterVon: 250, woerterBis: 350, betreffVon: 30, betreffBis: 50 };

const woerter = (s) => (String(s || '').match(/\S+/g) || []).length;

function median(a) {
  const v = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}
const minOf = (a) => (a.length ? Math.min(...a) : null);
const maxOf = (a) => (a.length ? Math.max(...a) : null);
const anteil = (n, von) => (von ? Math.round((n / von) * 100) / 100 : 0);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const ANREDE = /^(liebe[rs]?|lieber|sehr geehrte[rn]?|guten (tag|morgen|abend)|hallo|gr(ü|ue)ezi|hoi|hi|dear|hello|geschätzte[rn]?|werte[rn]?)\b/i;
const SCHLUSS = /^(freundliche[rn]?|herzliche[rn]?|beste[rn]?|mit (freundlichen|herzlichen|besten|lieben|sonnigen)|viele|sonnige[rn]?|herzlichst|bis bald|bis zum n(ä|ae)chsten|alles gute|auf bald|ihr |dein |euer |best |kind regards|warm regards|regards)/i;

// Zerlegt einen Newsletter-Text und misst ihn
function analysiere(text) {
  const z = zerlege(text);
  const lines = z.body.split('\n');
  const nichtLeer = lines.map((l, i) => ({ l: l.trim(), i })).filter(x => x.l);
  let anrede = null, anredeIdx = -1;
  const first = nichtLeer[0];
  if (first && first.l.length <= 120 && ANREDE.test(first.l)) { anrede = first.l.replace(/\*\*/g, '').replace(/[\s,;:!.]+$/, ''); anredeIdx = first.i; }
  let schluss = null, schlussIdx = -1;
  const tail = nichtLeer.slice(-6);
  for (const x of tail) {
    if (x.i > anredeIdx && x.l.length <= 80 && SCHLUSS.test(x.l.replace(/\*\*/g, ''))) { schluss = x.l.replace(/\*\*/g, '').replace(/[\s,;:!.]+$/, ''); schlussIdx = x.i; break; }
  }
  const kern = lines.filter((l, i) => i !== anredeIdx && (schlussIdx < 0 || i < schlussIdx)).join('\n');
  const bl = bloecke(kern);
  const ps = bl.filter(b => b.t === 'p');
  const hs = bl.filter(b => b.t === 'h');
  const us = bl.filter(b => b.t === 'ul');
  const absatzWoerter = ps.map(b => woerter(b.lines.join(' ')));
  return {
    betreff: z.betreff, vorschau: z.vorschau,
    betreffZeichen: z.betreff ? z.betreff.length : null,
    betreffWoerter: z.betreff ? woerter(z.betreff) : null,
    woerter: woerter(z.body),
    zwischentitel: hs.length, listen: us.length, absaetze: ps.length,
    abschnitte: hs.length > 0 ? hs.length : ps.length,
    absatzMedian: median(absatzWoerter),
    anrede, schluss
  };
}

// Häufigste Formel. Sind alle verschieden (zum Beispiel mit Namen), zählt das erste Wort.
function haeufigste(liste) {
  const vals = liste.filter(Boolean);
  if (!vals.length) return null;
  const gruppiere = (keyFn) => {
    const m = new Map();
    for (const v of vals) { const k = keyFn(v); const e = m.get(k) || { n: 0, beispiel: v }; e.n++; m.set(k, e); }
    return [...m.values()].sort((a, b) => b.n - a.n)[0];
  };
  let top = gruppiere(v => norm(v));
  let muster = false;
  if (top.n < 2 && vals.length > 1) {
    const g = gruppiere(v => norm(v).split(' ').slice(0, 2).join(' '));
    if (g.n >= 2) { top = g; muster = true; }
  }
  return { text: top.beispiel, anzahl: top.n, von: vals.length, nurAnfang: muster };
}

function kennzahlen(analysen) {
  const n = analysen.length;
  const w = analysen.map(a => a.woerter);
  const bz = analysen.map(a => a.betreffZeichen).filter(x => x != null);
  const bw = analysen.map(a => a.betreffWoerter).filter(x => x != null);
  const ab = analysen.map(a => a.abschnitte);
  return {
    anzahl: n,
    woerter: { median: median(w), min: minOf(w), max: maxOf(w) },
    betreffZeichen: { median: median(bz), min: minOf(bz), max: maxOf(bz), anzahl: bz.length },
    betreffWoerter: { median: median(bw) },
    abschnitte: { median: median(ab), min: minOf(ab), max: maxOf(ab) },
    zwischentitel: { anteil: anteil(analysen.filter(a => a.zwischentitel > 0).length, n), median: median(analysen.map(a => a.zwischentitel)) },
    listen: { anteil: anteil(analysen.filter(a => a.listen > 0).length, n) },
    absatzWoerter: { median: median(analysen.map(a => a.absatzMedian).filter(x => x != null)) },
    vorschau: { anteil: anteil(analysen.filter(a => a.vorschau).length, n) },
    anrede: haeufigste(analysen.map(a => a.anrede)),
    schluss: haeufigste(analysen.map(a => a.schluss))
  };
}

// Sammelt die Newsletter des Klienten. Gibt [{ text, quelle, datum }] in der Reihenfolge des Vorrangs, ohne Dubletten.
async function sammle(clientId) {
  const q = async (sql, p) => (await pool.query(sql, p).catch(() => ({ rows: [] }))).rows;
  const out = [];
  const gesehen = new Set();
  const nimm = (text, quelle, datum) => {
    const t = String(text || '').trim();
    if (t.length < MIN_ZEICHEN) return;
    const k = norm(t);
    if (gesehen.has(k)) return;
    gesehen.add(k);
    out.push({ text: t, quelle, datum: datum || null });
  };
  const reviews = await q(
    `SELECT original_text, edited_text, updated_at FROM review_requests
     WHERE client_id=$1 AND status='approved' AND (module_tile='newsletter' OR LOWER(COALESCE(module_label,'')) LIKE '%newsletter%')
     ORDER BY updated_at DESC LIMIT ${MAX_QUELLE}`, [clientId]);
  // Die Ausgangsfassungen der Freigaben zählen als gesehen, damit der unkorrigierte Entwurf nicht zusätzlich erscheint
  const roh = reviews.map(r => norm(r.original_text));
  for (const r of reviews) nimm(r.edited_text || r.original_text, 'freigegeben', r.updated_at);
  const beispiele = await q(
    `SELECT output_text, created_at FROM module_examples
     WHERE source_client_id=$1 AND (LOWER(COALESCE(module_key,'')) LIKE '%newsletter%' OR LOWER(COALESCE(label,'')) LIKE '%newsletter%')
     ORDER BY rating DESC, created_at DESC LIMIT ${MAX_QUELLE}`, [clientId]);
  for (const b of beispiele) nimm(b.output_text, 'beispiel', b.created_at);
  const analysen = await q(
    `SELECT result, created_at FROM analyses
     WHERE client_id=$1 AND result IS NOT NULL AND (user_rating IS NULL OR user_rating = 1)
       AND (feedback_key='text-gen-newsletter' OR LOWER(COALESCE(module_label,'')) LIKE '%newsletter%')
     ORDER BY created_at DESC LIMIT ${MAX_QUELLE}`, [clientId]);
  for (const a of analysen) {
    if (roh.includes(norm(a.result))) continue;
    nimm(a.result, 'entwurf', a.created_at);
  }
  return out;
}

function kuerzeBeispiel(text) {
  const z = zerlege(text);
  const kopf = (z.betreff ? `BETREFF: ${z.betreff}\n` : '') + (z.vorschau ? `VORSCHAU: ${z.vorschau}\n` : '');
  const paras = z.body.split(/\n\s*\n/);
  let acc = '';
  let gekuerzt = false;
  for (const p of paras) {
    if ((acc + p).length > BEISPIEL_ZEICHEN && acc) { gekuerzt = true; break; }
    acc += (acc ? '\n\n' : '') + p;
  }
  if (acc.length > BEISPIEL_ZEICHEN) { acc = acc.slice(0, BEISPIEL_ZEICHEN).replace(/\s+\S*$/, ''); gekuerzt = true; }
  return (kopf ? kopf + '\n' : '') + acc + (gekuerzt ? '\n[Rest gekürzt]' : '');
}

// Berechnet das Profil. Rückgabe: { anzahl, genug, basis, quellen, kennzahlen, beispiele, vorgabe }
async function profil(clientId) {
  const quellen = await sammle(clientId);
  const zaehl = { freigegeben: 0, beispiel: 0, entwurf: 0 };
  quellen.forEach(s => { zaehl[s.quelle]++; });
  const anzahl = quellen.length;
  if (anzahl < MIN_NEWSLETTER) return { anzahl, genug: false, basis: null, quellen: zaehl, kennzahlen: null, beispiele: [], vorgabe: laengenVorgabe(null) };
  // Vorrang: reichen freigegebene Fassungen und Beispiele allein, rechnen nur sie. Sonst alle.
  const vorrang = quellen.filter(s => s.quelle !== 'entwurf');
  const basisListe = vorrang.length >= MIN_NEWSLETTER ? vorrang : quellen;
  const mit = basisListe.map(s => ({ s, a: analysiere(s.text) }));
  const k = kennzahlen(mit.map(x => x.a));
  const med = k.woerter.median;
  const beispiele = mit.slice().sort((x, y) => Math.abs(x.a.woerter - med) - Math.abs(y.a.woerter - med)).slice(0, 3)
    .map(x => ({ quelle: x.s.quelle, woerter: x.a.woerter, text: kuerzeBeispiel(x.s.text) }));
  const p = { anzahl, genug: true, basis: vorrang.length >= MIN_NEWSLETTER ? 'freigegeben und Beispiele' : 'alle früheren Newsletter', quellen: zaehl, kennzahlen: k, beispiele };
  p.vorgabe = laengenVorgabe(p);
  return p;
}

// Längenvorgabe in Wörtern und Betreffzeilenlänge in Zeichen. Ohne Profil gilt der Standardrahmen der Plattform.
function laengenVorgabe(p) {
  if (!p || !p.genug || !p.kennzahlen || !p.kennzahlen.woerter.median) {
    return { woerterVon: STANDARD.woerterVon, woerterBis: STANDARD.woerterBis, betreffVon: STANDARD.betreffVon, betreffBis: STANDARD.betreffBis, ausProfil: false };
  }
  const k = p.kennzahlen;
  const m = k.woerter.median;
  const bz = k.betreffZeichen;
  const hatBetreff = bz.anzahl > 0 && bz.median;
  return {
    woerterVon: Math.max(60, Math.round(m * 0.85)),
    woerterBis: Math.max(100, Math.round(m * 1.15)),
    betreffVon: hatBetreff ? Math.max(10, bz.min) : STANDARD.betreffVon,
    betreffBis: hatBetreff ? Math.max(bz.max, bz.min + 5) : STANDARD.betreffBis,
    ausProfil: true
  };
}

// Textblock für Prompts. mitBeispielen: false für den Themenplan (nur Eckdaten), true für den Entwurf.
function profilBlock(p, { mitBeispielen = true } = {}) {
  if (!p || !p.genug) {
    const n = p ? p.anzahl : 0;
    return `NEWSLETTER-STILPROFIL: Von diesem Klienten liegen weniger als zwei frühere Newsletter vor (gefunden: ${n}). Ein belastbares Stilprofil ist darum nicht möglich. `
      + `Richte dich nach der Brand Voice und erfinde keine Gewohnheiten des Klienten. Standardrahmen: ${STANDARD.woerterVon} bis ${STANDARD.woerterBis} Wörter, Betreffzeile ${STANDARD.betreffVon} bis ${STANDARD.betreffBis} Zeichen.`;
  }
  const k = p.kennzahlen, v = p.vorgabe;
  const z = [];
  z.push(`NEWSLETTER-STILPROFIL (berechnet aus ${p.anzahl} früheren Newslettern dieses Klienten, Basis: ${p.basis}; die Zahlen sind gemessen)`);
  z.push(`- Länge: ${k.woerter.min} bis ${k.woerter.max} Wörter, Median ${k.woerter.median}. Schreibe ${v.woerterVon} bis ${v.woerterBis} Wörter.`);
  if (k.betreffZeichen.anzahl) z.push(`- Betreffzeile: Median ${k.betreffZeichen.median} Zeichen (${k.betreffZeichen.min} bis ${k.betreffZeichen.max}), etwa ${k.betreffWoerter.median} Wörter. Bleibe zwischen ${v.betreffVon} und ${v.betreffBis} Zeichen.`);
  else z.push(`- Betreffzeile: in den früheren Newslettern nicht erfasst, wähle ${STANDARD.betreffVon} bis ${STANDARD.betreffBis} Zeichen.`);
  const abs = k.abschnitte;
  z.push(`- Aufbau: Abschnitte pro Newsletter im Median ${abs.median} (${abs.min} bis ${abs.max}), ${k.zwischentitel.anteil >= 0.5 ? `meist mit Zwischentiteln (${Math.round(k.zwischentitel.anteil * 100)} Prozent der Newsletter)` : `meist ohne Zwischentitel (nur ${Math.round(k.zwischentitel.anteil * 100)} Prozent nutzen sie)`}, ${k.listen.anteil >= 0.5 ? `Listen kommen häufig vor (${Math.round(k.listen.anteil * 100)} Prozent)` : `Listen sind selten (${Math.round(k.listen.anteil * 100)} Prozent)`}.`);
  if (k.absatzWoerter.median) z.push(`- Absätze: typisch ${k.absatzWoerter.median} Wörter lang.`);
  if (k.vorschau.anteil > 0) z.push(`- Vorschautext: ${Math.round(k.vorschau.anteil * 100)} Prozent der Newsletter haben einen.`);
  if (k.anrede) z.push(`- Anrede: ${k.anrede.nurAnfang ? 'beginnt meist mit' : 'meist'} «${k.anrede.text}» (${k.anrede.anzahl} von ${k.anrede.von}).`);
  else z.push('- Anrede: keine feste Formel erkennbar.');
  if (k.schluss) z.push(`- Schlussformel: ${k.schluss.nurAnfang ? 'beginnt meist mit' : 'meist'} «${k.schluss.text}» (${k.schluss.anzahl} von ${k.schluss.von}).`);
  else z.push('- Schlussformel: keine feste Formel erkennbar.');
  let out = z.join('\n');
  if (mitBeispielen && p.beispiele.length) {
    out += '\n\nBEISPIELE FRÜHERER NEWSLETTER DIESES KLIENTEN (übernimm Stimme, Aufbau und Längenverhältnis, der Inhalt bleibt neu):\n'
      + p.beispiele.map((b, i) => fence(`newsletter-beispiel-${i + 1}`, b.text)).join('\n\n');
  }
  return out;
}

module.exports = { profil, profilBlock, laengenVorgabe, analysiere, kennzahlen, haeufigste, sammle, median, kuerzeBeispiel, MIN_NEWSLETTER, STANDARD };
