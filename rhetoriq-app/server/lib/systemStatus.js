// Betriebszustand in der Tabelle system_status (key, value JSONB, updated_at).
// Genutzt vom KI-Wächter, vom Hinweisbalken und vom Schalter für das Reservekonto.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');

async function getStatus(key, fallback = null) {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT value FROM system_status WHERE key=$1', [key]);
    if (!rows.length) return fallback;
    const v = rows[0].value;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) {
    return fallback;
  }
}

async function setStatus(key, value) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO system_status (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]);
  return value;
}

module.exports = { getStatus, setStatus };
