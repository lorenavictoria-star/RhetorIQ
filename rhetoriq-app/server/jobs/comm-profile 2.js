// Alle zwei Wochen: neue Messung für Klienten mit Ausgangslage und mindestens drei neuen verwendeten Texten.
const { pool } = require('../db');
const { ensureSchema } = require('../lib/schemaRedesign');
const { snapshotClient } = require('../lib/commProfile');

async function runCommProfileJob() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT DISTINCT client_id FROM communication_profiles WHERE kind='baseline'`);
  let done = 0, skipped = 0;
  const budget = require('../lib/budget');
  for (const r of rows) {
    // Tagesbudget (lib/budget.js): ist es erreicht, wartet der Rest bis zum nächsten Lauf
    if (!(await budget.allow('messungen')).ok) { skipped++; continue; }
    try {
      const out = await snapshotClient(r.client_id, { minTexts: 3 });
      if (out.skipped) skipped++; else done++;
    } catch (e) { console.error('[comm-profile] Klient', r.client_id, e.message); }
  }
  console.log(`[comm-profile] gemessen: ${done}, übersprungen: ${skipped}`);
  return { done, skipped };
}
module.exports = { runCommProfileJob };
