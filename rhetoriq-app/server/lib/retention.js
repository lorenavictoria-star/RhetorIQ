// Löschfristen (Befunde F-10 und F-17), täglich per Zeitplan:
//  - E-Mail-Warteschlange: Inhalt und Anhang gesendeter Mails nach 7 Tagen leeren, Zeilen nach 90 Tagen löschen
//  - Fehlerprotokoll der KI (generation_errors) nach 90 Tagen löschen
const { pool } = require('../db');

async function runRetention() {
  const out = { emptied: 0, deletedMails: 0, deletedErrors: 0 };
  try {
    await pool.query('ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS attachments JSONB');
    const a = await pool.query(
      `UPDATE email_outbox SET body='', attachments=NULL
       WHERE status='sent' AND sent_at < NOW() - INTERVAL '7 days' AND (body <> '' OR attachments IS NOT NULL)`);
    out.emptied = a.rowCount || 0;
    const b = await pool.query(`DELETE FROM email_outbox WHERE created_at < NOW() - INTERVAL '90 days'`);
    out.deletedMails = b.rowCount || 0;
  } catch (e) { console.error('[retention] E-Mail-Warteschlange:', e.message); }
  try {
    const c = await pool.query(`DELETE FROM generation_errors WHERE created_at < NOW() - INTERVAL '90 days'`);
    out.deletedErrors = c.rowCount || 0;
  } catch (e) { console.error('[retention] Fehlerprotokoll:', e.message); }
  if (out.emptied || out.deletedMails || out.deletedErrors) console.log('[retention]', JSON.stringify(out));
  return out;
}

module.exports = { runRetention };
