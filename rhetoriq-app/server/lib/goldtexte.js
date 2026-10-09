const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { changedShare, learnKeyFor, words } = require('./learnFromCorrections');

// Goldtexte: die von der Beraterin korrigierte und gesendete Fassung ist das beste Lernsignal.
// Pro Klient und Textart bleiben die jüngsten 20 erhalten. Beim Erzeugen eines Textes dienen bis zu zwei davon
// als Stilvorbild. Ausschliesslich Texte des eigenen Klienten.
const MAX_PER_KEY = 20;
const MIN_LEN = 200;
const MAX_LEN = 6000;
const MIN_CHANGED = 0.1;
const BLOCK_LIMIT = 3000;   // Zeichen insgesamt im Auftrag
const HEADER = '\n\nVorbild: So hat die Beraterin einen früheren Text dieses Klienten finalisiert. Stil übernehmen, Inhalt nicht.\n';

// Speichert die gesendete Fassung einer Freigabe als Goldtext, wenn sie die Bedingungen erfüllt.
async function saveGoldFromReview(reviewId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM review_requests WHERE id=$1', [reviewId]);
  const rv = rows[0];
  if (!rv || !rv.client_id || rv.status !== 'approved') return { skipped: 'nicht gesendet' };
  const text = String(rv.edited_text || '').trim();
  if (text.length < MIN_LEN || text.length > MAX_LEN) return { skipped: 'Länge' };
  if (changedShare(rv.original_text, text) < MIN_CHANGED) return { skipped: 'kaum verändert' };
  const key = learnKeyFor(rv);
  const { rows: ex } = await pool.query('SELECT id, text, quelle_review_id FROM goldtexte WHERE client_id=$1 AND feedback_key=$2', [rv.client_id, key]);
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  // Dieselbe Freigabe nochmals gesendet: Eintrag aktualisieren. Gleicher Text aus anderer Freigabe: nichts tun.
  const same = ex.find(e => Number(e.quelle_review_id) === Number(rv.id));
  if (same) {
    await pool.query('UPDATE goldtexte SET text=$2 WHERE id=$1', [same.id, text]);
    return { saved: true, updated: true };
  }
  if (ex.some(e => norm(e.text) === norm(text))) return { skipped: 'Duplikat' };
  await pool.query('INSERT INTO goldtexte (client_id, feedback_key, text, quelle_review_id) VALUES ($1,$2,$3,$4)', [rv.client_id, key, text, rv.id]);
  // Älteste löschen, wenn mehr als 20
  const { rows: all } = await pool.query('SELECT id FROM goldtexte WHERE client_id=$1 AND feedback_key=$2 ORDER BY created_at DESC, id DESC', [rv.client_id, key]);
  const drop = all.slice(MAX_PER_KEY).map(r => r.id);
  for (const id of drop) await pool.query('DELETE FROM goldtexte WHERE id=$1', [id]);
  return { saved: true, deleted: drop.length };
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  a.forEach(w => { if (b.has(w)) n++; });
  return n / Math.min(a.size, b.size);
}

// Bis zu zwei passende Goldtexte (jüngster und ein inhaltlich ähnlicher) als Stilvorbild. Leer, wenn es keine gibt.
// queryText: Text des Auftrags, für die Ähnlichkeit (einfache Wortüberlappung).
async function getGoldBlock(clientId, keys, queryText) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!clientId || !list.length) return '';
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      'SELECT id, feedback_key, text FROM goldtexte WHERE client_id=$1 AND feedback_key = ANY($2) ORDER BY created_at DESC, id DESC LIMIT $3',
      [clientId, list, MAX_PER_KEY]);
    if (!rows.length) return '';
    // das genauere Ende der Schlüsselliste hat Vorrang vor dem allgemeinen, sonst zählt die Reihenfolge nach Datum
    const exact = rows.filter(r => r.feedback_key === list[list.length - 1]);
    const pool2 = exact.length ? exact : rows;
    const chosen = [pool2[0]];
    const rest = pool2.slice(1);
    if (rest.length) {
      const q = words(queryText);
      let best = rest[0], bestScore = -1;
      for (const r of rest) {
        const s = overlap(q, words(r.text));
        if (s > bestScore) { best = r; bestScore = s; }
      }
      chosen.push(best);
    }
    const room = BLOCK_LIMIT - HEADER.length - 20 - chosen.length * 40;
    const per = Math.floor(room / chosen.length);
    let out = HEADER;
    chosen.forEach((g, i) => {
      const t = g.text.length > per ? g.text.slice(0, per).replace(/\s+\S*$/, '') + ' …' : g.text;
      out += `\nVORBILD ${i + 1}:\n${t}\n`;
    });
    return out.length > BLOCK_LIMIT ? out.slice(0, BLOCK_LIMIT) : out;
  } catch (e) {
    console.error('[gold] lesen fehlgeschlagen:', e.message);
    return '';
  }
}

// Text des Auftrags für die Ähnlichkeitssuche: alle Textfelder der Eingabe
function queryTextOf(data) {
  return Object.values(data || {}).filter(v => typeof v === 'string').join(' ').slice(0, 4000);
}

module.exports = { saveGoldFromReview, getGoldBlock, queryTextOf, MAX_PER_KEY, BLOCK_LIMIT };
