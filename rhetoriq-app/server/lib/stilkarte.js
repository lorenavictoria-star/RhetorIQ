// Stilkarte je Klient: fünf Zeilen Kennzahlen aus den zuletzt verwendeten Texten, rein lokal berechnet (ohne KI).
// Gespeichert in communication_profiles als kind 'stilkarte' (metrics), höchstens eine Berechnung pro Woche.
// Im Auftrag erscheint sie als drei Zeilen «Stilkarte des Klienten: ...» im dynamischen Teil, begrenzt auf 400 Zeichen.
// Die Übernahmequote steht in lib/uebernahme.js, die Lernkurve in lib/lernkurve.js und werden hier nicht gedoppelt.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { computeMetrics } = require('./commProfile');
const { anredeTreffer } = require('./lint');
const { TEXT_MODULES } = require('./temperaturen');

const MIN_TEXTS = 3;            // darunter sagt die Karte nichts aus
const MAX_TEXTS = 20;
const MIN_CHARS = 80;
const KURZ = 12;                // bis so viele Wörter gilt ein Satz als kurz
const GUELTIG_TAGE = 7;
const MAX_ZEICHEN = 400;

const woerter = t => String(t || '').match(/[\p{L}\p{N}]+/gu) || [];
const zahl = (n, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d).replace('.', ',');

function saetzeVon(t) { return String(t || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => woerter(s).length >= 3); }

// Reine Berechnung aus einer Liste von Texten. Gibt null zurück, wenn zu wenig da ist.
function berechne(texte) {
  const list = (texte || []).map(t => String(t || '').trim()).filter(t => t.length >= MIN_CHARS);
  if (list.length < MIN_TEXTS) return null;
  const alle = list.flatMap(saetzeVon);
  if (!alle.length) return null;
  const laengen = alle.map(s => woerter(s).length);
  const schnitt = laengen.reduce((a, b) => a + b, 0) / laengen.length;
  const kurz = laengen.filter(n => n <= KURZ).length / laengen.length;
  let sie = 0, du = 0;
  list.forEach(t => { const r = anredeTreffer(t); sie += r.sie.length; du += r.du.length; });
  let anrede = null;
  if (sie || du) anrede = sie >= du * 2 ? 'Sie' : du >= sie * 2 ? 'du' : 'gemischt';
  const absaetze = list.flatMap(t => t.split(/\n\s*\n/)).map(a => a.trim()).filter(a => saetzeVon(a).length >= 1);
  const absSaetze = absaetze.length ? absaetze.reduce((n, a) => n + saetzeVon(a).length, 0) / absaetze.length : 0;
  const absWoerter = absaetze.length ? absaetze.reduce((n, a) => n + woerter(a).length, 0) / absaetze.length : 0;
  const wendungen = (computeMetrics(list).topPhrases || []).slice(0, 3).map(p => p.phrase);
  return {
    satzlaenge: Math.round(schnitt * 10) / 10,
    kurzeSaetze: Math.round(kurz * 100),
    anrede,
    wendungen,
    absatzSaetze: Math.round(absSaetze * 10) / 10,
    absatzWoerter: Math.round(absWoerter),
    saetze: alle.length,
    texte: list.length
  };
}

// Die fünf Zeilen für die Anzeige
function zeilen(k) {
  if (!k) return [];
  return [
    `Durchschnittliche Satzlänge: ${zahl(k.satzlaenge)} Wörter`,
    `Anteil kurzer Sätze (bis ${KURZ} Wörter): ${k.kurzeSaetze} Prozent`,
    `Anrede: ${k.anrede ? (k.anrede === 'gemischt' ? 'Sie und du gemischt' : k.anrede) : 'nicht erkennbar'}`,
    `Häufigste Wendungen: ${k.wendungen && k.wendungen.length ? k.wendungen.map(w => '«' + w + '»').join(', ') : 'keine wiederkehrenden'}`,
    `Absatzlänge: ${zahl(k.absatzSaetze)} Sätze, ${k.absatzWoerter} Wörter`
  ];
}

// Drei Zeilen für den Auftrag, höchstens 400 Zeichen
function auftragsZeilen(k) {
  if (!k) return '';
  const anr = k.anrede && k.anrede !== 'gemischt' ? `, Anrede ${k.anrede}` : '';
  const z1 = `Stilkarte des Klienten: Sätze im Schnitt ${zahl(k.satzlaenge)} Wörter, ${k.kurzeSaetze} Prozent kurze Sätze (bis ${KURZ} Wörter)${anr}.`;
  const z3 = `Absätze im Schnitt ${zahl(k.absatzSaetze)} Sätze.`;
  let w = (k.wendungen || []).map(x => '«' + x + '»');
  const bau = () => [z1, w.length ? `Häufige Wendungen: ${w.join(', ')}.` : null, z3].filter(Boolean).join('\n');
  let s = bau();
  while (s.length > MAX_ZEICHEN && w.length) { w = w.slice(0, -1); s = bau(); }
  return s.length > MAX_ZEICHEN ? s.slice(0, MAX_ZEICHEN - 1) + '…' : s;
}

// Die zuletzt verwendeten Texte: gesendete Freigaben (Fassung der Beraterin), sonst erzeugte Texte
async function letzteTexte(clientId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(edited_text, original_text) AS t FROM review_requests
     WHERE client_id=$1 AND status='approved' AND LENGTH(COALESCE(edited_text, original_text, '')) >= $2
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT $3`, [clientId, MIN_CHARS, MAX_TEXTS]);
  let texte = rows.map(r => r.t);
  if (texte.length < MIN_TEXTS) {
    const { rows: an } = await pool.query(
      `SELECT result FROM analyses WHERE client_id=$1 AND module = ANY($2) AND COALESCE(user_rating,0) >= 0 AND LENGTH(COALESCE(result,'')) >= $3
       ORDER BY created_at DESC, id DESC LIMIT $4`, [clientId, [...TEXT_MODULES], MIN_CHARS, MAX_TEXTS]);
    texte = texte.concat(an.map(r => r.result)).slice(0, MAX_TEXTS);
  }
  return texte;
}

// Aktuelle Karte: aus dem Speicher, wenn jünger als eine Woche, sonst neu berechnet und gespeichert. null, wenn zu wenig Texte da sind.
async function holeKarte(clientId, jetzt = new Date()) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT metrics, created_at FROM communication_profiles WHERE client_id=$1 AND kind='stilkarte' ORDER BY created_at DESC, id DESC LIMIT 1`, [clientId]);
  if (rows[0] && rows[0].metrics && (jetzt - new Date(rows[0].created_at)) < GUELTIG_TAGE * 86400000) return { karte: rows[0].metrics, aktualisiert: rows[0].created_at };
  const karte = berechne(await letzteTexte(clientId));
  if (!karte) return rows[0] && rows[0].metrics ? { karte: rows[0].metrics, aktualisiert: rows[0].created_at } : null;
  const { rows: neu } = await pool.query(
    `INSERT INTO communication_profiles (client_id, kind, metrics, text_count) VALUES ($1,'stilkarte',$2,$3) RETURNING created_at`,
    [clientId, JSON.stringify(karte), karte.texte]);
  // nur die letzten fünf Karten behalten
  await pool.query(
    `DELETE FROM communication_profiles WHERE client_id=$1 AND kind='stilkarte' AND id NOT IN (SELECT id FROM communication_profiles WHERE client_id=$1 AND kind='stilkarte' ORDER BY created_at DESC, id DESC LIMIT 5)`,
    [clientId]).catch(() => {});
  return { karte, aktualisiert: neu[0].created_at };
}

// Für analyze.js: Textblock für den dynamischen Teil des Auftrags. Fehler und fehlende Daten ergeben einen leeren Text.
async function stilkarteBlock(clientId, module) {
  if (!clientId || !TEXT_MODULES.has(module)) return '';
  try {
    const r = await holeKarte(clientId);
    const z = r && auftragsZeilen(r.karte);
    return z ? '\n\n' + z : '';
  } catch (e) { return ''; }
}

module.exports = { berechne, zeilen, auftragsZeilen, holeKarte, stilkarteBlock, letzteTexte, MIN_TEXTS, MAX_ZEICHEN };
