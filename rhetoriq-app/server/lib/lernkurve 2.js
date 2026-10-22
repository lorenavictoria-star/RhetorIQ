// Lernkurve (Stufe 1 aus «Messen statt hoffen»): Wie viele Sätze der KI-Fassung übernimmt die Beraterin unverändert?
// Alles wird lokal berechnet, ohne KI-Aufruf. Grundlage sind die gesendeten Freigaben (review_requests, Status approved).
const { pool } = require('../db');

const MIN_CHARS = 40;          // kürzere Texte sagen nichts aus (wie in learnFromCorrections)
const MIN_PER_MONTH = 3;       // ein Monat zählt erst ab so vielen Freigaben
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Sätze trennen wie computeMetrics in lib/commProfile.js: nach . ! ? und mit mindestens drei Wörtern
function splitSentences(t) {
  return String(t || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => (s.match(/[\p{L}\p{N}]+/gu) || []).length >= 3);
}
// Einfache Normalisierung: Grossschreibung, Leerraum und Satzzeichen zählen nicht als Änderung
function norm(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// { total, same }: Sätze der KI-Fassung und wie viele davon unverändert in der gesendeten Fassung stehen
function zaehleSaetze(before, after) {
  const a = splitSentences(before).map(norm).filter(Boolean);
  const set = new Set(splitSentences(after).map(norm));
  return { total: a.length, same: a.filter(s => set.has(s)).length };
}
// Anteil von 0 bis 1 (null, wenn die KI-Fassung keine Sätze enthält)
function anteilUnveraenderterSaetze(before, after) {
  const z = zaehleSaetze(before, after);
  return z.total ? z.same / z.total : null;
}

function monatsSchluessel(d) { return d.getFullYear() * 12 + d.getMonth(); }

// Kurve der letzten `monate` Monate (ältester zuerst). Je Monat über alle Freigaben gepoolt.
async function monatlicheKurve(clientId, monate = 6, jetzt = new Date()) {
  const n = Math.max(1, Math.min(24, Number(monate) || 6));
  const endKey = monatsSchluessel(jetzt);
  const startKey = endKey - (n - 1);
  const von = new Date(Math.floor(startKey / 12), startKey % 12, 1);
  const { rows } = await pool.query(
    `SELECT original_text, edited_text, updated_at, created_at FROM review_requests
     WHERE client_id=$1 AND status='approved' AND edited_text IS NOT NULL AND COALESCE(updated_at, created_at) >= $2`,
    [clientId, von]);
  const buckets = new Map();
  for (let k = startKey; k <= endKey; k++) buckets.set(k, { monat: new Date(Math.floor(k / 12), k % 12, 1), freigaben: 0, total: 0, same: 0 });
  for (const r of rows) {
    if (String(r.original_text || '').length < MIN_CHARS) continue;
    const z = zaehleSaetze(r.original_text, r.edited_text);
    if (!z.total) continue;
    const b = buckets.get(monatsSchluessel(new Date(r.updated_at || r.created_at)));
    if (!b) continue;
    b.freigaben++; b.total += z.total; b.same += z.same;
  }
  return [...buckets.values()].map(b => ({
    monat: `${b.monat.getFullYear()}-${String(b.monat.getMonth() + 1).padStart(2, '0')}`,
    name: MONATE[b.monat.getMonth()],
    freigaben: b.freigaben,
    saetze: b.total,
    prozent: b.total ? Math.round(100 * b.same / b.total) : null,
    ausreichend: b.freigaben >= MIN_PER_MONTH
  }));
}

// Sätze für die Anzeige. Nur ab zwei Monaten mit mindestens drei Freigaben, sonst null.
function lernkurvenSatz(kurve, wer = 'Ihre Beraterin') {
  const ok = kurve.filter(m => m.ausreichend);
  if (ok.length < 2) return { klient: null, beraterin: null };
  const a = ok[0], z = ok[ok.length - 1];
  return {
    klient: `Im ${z.name} übernahm ${wer} ${z.prozent} Prozent Ihrer Sätze unverändert, im ${a.name} waren es ${a.prozent} Prozent.`,
    beraterin: `Im ${z.name} blieben ${z.prozent} Prozent der Sätze der KI-Fassung unverändert, im ${a.name} waren es ${a.prozent} Prozent.`
  };
}

async function beraterName(clientId) {
  try {
    const { rows } = await pool.query(`SELECT u.name FROM clients c JOIN users u ON u.id=c.advisor_id WHERE c.id=$1`, [clientId]);
    const first = String((rows[0] && rows[0].name) || '').trim().split(/\s+/)[0];
    return first || 'Ihre Beraterin';
  } catch { return 'Ihre Beraterin'; }
}

async function lernkurve(clientId, monate = 6) {
  const kurve = await monatlicheKurve(clientId, monate);
  const s = lernkurvenSatz(kurve, await beraterName(clientId));
  return { kurve, satz: s.klient, satzBeraterin: s.beraterin, mindestFreigaben: MIN_PER_MONTH };
}

module.exports = { splitSentences, anteilUnveraenderterSaetze, monatlicheKurve, lernkurvenSatz, lernkurve, MONATE };
