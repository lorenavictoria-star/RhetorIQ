// Monatlicher Themenplan: am 1. um 06:00 (Europe/Zurich) für jeden Klienten mit aktiviertem Themenplan.
// Abschaltbar mit THEMENPLAN=aus.
const { pool } = require('../db');
const { ensureSchema } = require('../lib/schemaRedesign');
const tp = require('../lib/themenplan');

async function runThemenplanJob(opts = {}) {
  if (String(process.env.THEMENPLAN || '').toLowerCase() === 'aus') { console.log('[themenplan] abgeschaltet (THEMENPLAN=aus)'); return []; }
  await ensureSchema();
  const { rows } = await pool.query('SELECT id FROM clients WHERE themenplan_aktiv = TRUE ORDER BY id');
  const out = [];
  for (const c of rows) {
    try { out.push({ clientId: c.id, ...(await tp.runForClient(c.id, opts)) }); }
    catch (e) { console.error('[themenplan] Klient', c.id, e.message); out.push({ clientId: c.id, status: 'fehler' }); }
  }
  console.log(`[themenplan] ${out.filter(x => x.status === 'fertig').length} von ${rows.length} Läufen erzeugt`);
  return out;
}

module.exports = { runThemenplanJob };
