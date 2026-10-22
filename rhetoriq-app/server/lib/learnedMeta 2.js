const { pool } = require('../db');

// Datum und Zähler je gelerntem Satz. Die gelernte Vorliebe bleibt wie bisher ein Text je Klient, Textart
// und Kategorie (client_feedback_learnings.summary). Die Angaben je Satz liegen additiv in satz_meta (JSONB),
// vorhandene Lernstände bleiben unverändert und fallen auf das Änderungsdatum der Zeile und den Zähler 1 zurück.
let ensured = null;
function ensureMeta() {
  if (!ensured) ensured = pool.query('ALTER TABLE client_feedback_learnings ADD COLUMN IF NOT EXISTS satz_meta JSONB').catch(e => { ensured = null; throw e; });
  return ensured;
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function sentences(t) {
  return String(t || '').replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+/).map(x => x.trim()).filter(Boolean);
}

function listSentences(row) {
  const meta = (row && row.satz_meta && typeof row.satz_meta === 'object') ? row.satz_meta : {};
  return sentences(row.summary).map(s => {
    const m = meta[norm(s)] || {};
    return { text: s, at: m.at || row.updated_at, count: m.count || 1 };
  });
}

// Vermerkt einen gelernten Satz mit Datum und Zähler (erhöht den Zähler, wenn er schon bekannt ist).
async function noteSentence(clientId, moduleKey, category, text, count) {
  await ensureMeta();
  const { rows } = await pool.query('SELECT satz_meta FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category]);
  if (!rows[0]) return;
  const meta = (rows[0].satz_meta && typeof rows[0].satz_meta === 'object') ? { ...rows[0].satz_meta } : {};
  const k = norm(text);
  const prev = meta[k];
  meta[k] = { at: new Date().toISOString(), count: prev ? (prev.count || 1) + 1 : Math.max(1, count || 1) };
  await pool.query('UPDATE client_feedback_learnings SET satz_meta=$4 WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category, JSON.stringify(meta)]);
}

// Hält das bisherige Datum der vorhandenen Sätze fest, bevor die Zeile neu geschrieben wird (updated_at ändert sich dabei).
async function preserveDates(clientId, moduleKey, category) {
  await ensureMeta();
  const { rows } = await pool.query('SELECT summary, updated_at, satz_meta FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category]);
  if (!rows[0]) return;
  const meta = (rows[0].satz_meta && typeof rows[0].satz_meta === 'object') ? { ...rows[0].satz_meta } : {};
  let changed = false;
  for (const s of sentences(rows[0].summary)) {
    if (!meta[norm(s)]) { meta[norm(s)] = { at: new Date(rows[0].updated_at).toISOString(), count: 1 }; changed = true; }
  }
  if (changed) await pool.query('UPDATE client_feedback_learnings SET satz_meta=$4 WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category, JSON.stringify(meta)]);
}

// Entfernt einen einzelnen gelernten Satz. Ist danach nichts mehr übrig, wird die Zeile gelöscht.
async function forgetSentence(row, text) {
  await ensureMeta();
  const k = norm(text);
  const rest = sentences(row.summary).filter(s => norm(s) !== k);
  if (rest.length === sentences(row.summary).length) return { found: false };
  if (!rest.length) {
    await pool.query('DELETE FROM client_feedback_learnings WHERE id=$1', [row.id]);
    return { found: true, deleted: true };
  }
  const meta = (row.satz_meta && typeof row.satz_meta === 'object') ? { ...row.satz_meta } : {};
  delete meta[k];
  await pool.query('UPDATE client_feedback_learnings SET summary=$2, satz_meta=$3 WHERE id=$1', [row.id, rest.join(' '), JSON.stringify(meta)]);
  return { found: true, deleted: false };
}

module.exports = { preserveDates, ensureMeta, listSentences, noteSentence, forgetSentence, sentences };
