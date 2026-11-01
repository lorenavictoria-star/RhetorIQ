// Einmal pro Zeitraum: Läuft derselbe Job auf zwei Serverinstanzen gleichzeitig (zum Beispiel beim Deploy auf Render),
// darf trotzdem nur eine Instanz die Mail schicken. Wer den Schlüssel zuerst einträgt, darf senden.
const { pool } = require('../db');

async function ersterLauf(schluessel, db = pool) {
  try {
    await db.query('CREATE TABLE IF NOT EXISTS job_laeufe (schluessel TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW())');
    const { rows } = await db.query('INSERT INTO job_laeufe (schluessel) VALUES ($1) ON CONFLICT (schluessel) DO NOTHING RETURNING schluessel', [schluessel]);
    return rows.length > 0;
  } catch (e) {
    console.error('[einmalig] Prüfung fehlgeschlagen, Job läuft trotzdem:', e.message);
    return true;   // lieber doppelt als gar nicht
  }
}

// Zürcher Monat als Schlüsselteil, zum Beispiel 2026-11
function monatsSchluessel(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return p.find(x => x.type === 'year').value + '-' + p.find(x => x.type === 'month').value;
}

module.exports = { ersterLauf, monatsSchluessel };
