// Übernahmequote: Anteil der KI-Texte, die Lorena unverändert (Veränderung unter 10 Prozent) sendet.
// Rechnet ohne KI-Aufruf aus review_requests (original_text gegen edited_text bei gesendeten Freigaben).
const { pool } = require('../db');
const { changedShare } = require('./learnFromCorrections');

const UNCHANGED_BELOW = 0.1; // unter 10 Prozent veränderter Anteil gilt als unverändert gesendet
const DAY = 24 * 3600 * 1000;

// Reine Berechnung aus Zeilen {original_text, edited_text}
function compute(rows) {
  const used = (rows || []).filter(r => r && r.original_text && r.edited_text);
  if (!used.length) return { count: 0, unchanged: 0, ratePct: null, avgChangedPct: null };
  let unchanged = 0, sum = 0;
  for (const r of used) {
    const s = changedShare(r.original_text, r.edited_text);
    sum += s;
    if (s < UNCHANGED_BELOW) unchanged++;
  }
  return { count: used.length, unchanged, ratePct: Math.round(unchanged / used.length * 100), avgChangedPct: Math.round(sum / used.length * 100) };
}

// Zeitraum: 'week' = die letzten 7 Tage, 'month' = der Kalendermonat, in dem 'now' liegt (UTC)
function range(period, now = new Date(), back = 0) {
  if (period === 'month') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1));
    return { from, to };
  }
  const end = new Date(now.getTime() - back * 7 * DAY);
  return { from: new Date(end.getTime() - 7 * DAY), to: back === 0 ? new Date(now.getTime() + 1000) : end };
}

async function rowsFor(clientId, from, to) {
  const params = [from.toISOString(), to.toISOString()];
  let where = `status='approved' AND edited_text IS NOT NULL AND updated_at >= $1 AND updated_at < $2`;
  if (clientId != null) { params.push(clientId); where += ` AND client_id=$3`; }
  const { rows } = await pool.query(`SELECT client_id, original_text, edited_text FROM review_requests WHERE ${where}`, params);
  return rows;
}

function delta(cur, prev) { return cur.ratePct != null && prev.ratePct != null ? cur.ratePct - prev.ratePct : null; }

// Zahlen je Klient: aktueller Zeitraum, Vorperiode, Veränderung in Prozentpunkten
async function forClient(clientId, period = 'week', now = new Date()) {
  const c = range(period, now, 0), p = range(period, now, 1);
  const cur = compute(await rowsFor(clientId, c.from, c.to));
  const prev = compute(await rowsFor(clientId, p.from, p.to));
  return { period, current: cur, previous: prev, deltaPts: delta(cur, prev) };
}

// Alle Klienten mit Freigaben im aktuellen Zeitraum (für die Berichte)
async function forAllClients(period = 'week', now = new Date()) {
  const c = range(period, now, 0), p = range(period, now, 1);
  const curRows = await rowsFor(null, c.from, c.to), prevRows = await rowsFor(null, p.from, p.to);
  const by = (rows) => rows.reduce((m, r) => { (m[r.client_id] = m[r.client_id] || []).push(r); return m; }, {});
  const cb = by(curRows), pb = by(prevRows);
  const ids = Object.keys(cb).map(Number);
  if (!ids.length) return [];
  const { rows: names } = await pool.query(`SELECT id, name FROM clients`);
  const nm = Object.fromEntries(names.map(n => [n.id, n.name]));
  return ids.map(id => {
    const cur = compute(cb[id]), prev = compute(pb[id]);
    return { clientId: id, name: nm[id] || `Klient ${id}`, current: cur, previous: prev, deltaPts: delta(cur, prev) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// Textzeilen für Wochen- und Monatsbericht
function reportLines(list, label = 'Vorwoche') {
  if (!list.length) return ['  Keine gesendeten Freigaben in diesem Zeitraum.'];
  return list.map(r => {
    const d = r.deltaPts == null ? `kein Vergleich mit der ${label}` : `${r.deltaPts > 0 ? '+' : ''}${r.deltaPts} Punkte gegenüber der ${label}`;
    return `  - ${r.name}: ${r.current.ratePct} % unverändert gesendet (${r.current.unchanged} von ${r.current.count} Freigaben), durchschnittlich ${r.current.avgChangedPct} % verändert, ${d}`;
  });
}

module.exports = { compute, range, forClient, forAllClients, reportLines, UNCHANGED_BELOW };
