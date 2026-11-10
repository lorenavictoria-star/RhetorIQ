// Einmal pro Zeitraum: Läuft derselbe Job auf zwei Serverinstanzen gleichzeitig (zum Beispiel beim Deploy auf Render),
// darf trotzdem nur eine Instanz die Mail schicken. Wer den Schlüssel zuerst einträgt, darf senden.
const { pool } = require('../db');

let angelegt = false;   // Tabelle nur einmal je Prozess anlegen

async function ersterLauf(schluessel, db = pool) {
  try {
    if (!angelegt) {
      await db.query('CREATE TABLE IF NOT EXISTS job_laeufe (schluessel TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW())');
      angelegt = true;
    }
    await db.query('INSERT INTO job_laeufe (schluessel) VALUES ($1)', [schluessel]);
    return true;
  } catch (e) {
    if (e && (e.code === '23505' || /duplicate key|unique/i.test(String(e.message)))) return false;   // Schlüssel gibt es schon: eine andere Instanz war schneller
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
