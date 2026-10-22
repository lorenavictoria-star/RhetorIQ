// Löschfristen (Befunde F-10 und F-17), täglich per Zeitplan:
//  - E-Mail-Warteschlange: Inhalt und Anhang gesendeter Mails nach 7 Tagen leeren, Zeilen nach 90 Tagen löschen
//  - Fehlerprotokoll der KI (generation_errors) nach 90 Tagen löschen
//  - Protokoll des Daten-Wächters (datenwaechter_log, ohne Inhalt) nach 90 Tagen löschen
//  - Texte je Klient (clients.aufbewahrung_tage): Eingaben, Ergebnisse, Hinweise zu Überarbeitungen und Feedback-Notizen älterer Aufträge leeren, automatisch gelernte Beispiele löschen
const { pool } = require('../db');

// Leert Eingaben und Ergebnisse (analyses) und löscht automatisch erzeugte Lernbeispiele, die älter sind als die Frist des Klienten.
// Klienten ohne Frist bleiben unberührt. Zeilen, Module, Daten und Bewertungen bleiben für Zähler und Statistik erhalten.
async function leereAlteTexte() {
  await require('./schemaRedesign').ensureSchema().catch(() => {});   // Spalte ueberarbeitung_hinweis
  const { rows } = await pool.query('SELECT id, aufbewahrung_tage FROM clients WHERE aufbewahrung_tage IS NOT NULL AND geloescht_am IS NULL');
  let n = 0;
  for (const c of rows) {
    const tage = Number(c.aufbewahrung_tage);
    if (!Number.isFinite(tage) || tage < 7) continue;
    // Eingaben, Ergebnisse, Hinweise zu Überarbeitungen und Feedback-Notizen älterer Aufträge leeren
    const a = await pool.query(
      `UPDATE analyses SET input_data=NULL, result=NULL, ueberarbeitung_hinweis=NULL, feedback_note=NULL
       WHERE client_id=$1 AND created_at < NOW() - ($2 || ' days')::interval
         AND (input_data IS NOT NULL OR result IS NOT NULL OR ueberarbeitung_hinweis IS NOT NULL OR feedback_note IS NOT NULL)`,
      [c.id, String(tage)]);
    n += a.rowCount || 0;
    // Rohprotokoll des Feedbacks: nur der Notiztext wird geleert, Bewertung und Kategorie bleiben für die Statistik
    await pool.query(
      `UPDATE client_feedback_history SET note=NULL
       WHERE client_id=$1 AND created_at < NOW() - ($2 || ' days')::interval AND note IS NOT NULL`,
      [c.id, String(tage)]).catch(e => console.error('[retention] Feedback-Protokoll:', e.message));
    await pool.query(
      `DELETE FROM module_examples
       WHERE source_client_id=$1 AND auto_generated=true AND created_at < NOW() - ($2 || ' days')::interval`,
      [c.id, String(tage)]);
  }
  return n;
}

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
  try {
    out.deletedDatenwaechter = await require('./datenwaechterStore').loescheAlt();
  } catch (e) { console.error('[retention] Daten-Wächter-Protokoll:', e.message); }
  try {
    out.geleerteTexte = await leereAlteTexte();
  } catch (e) { console.error('[retention] Texte je Klient:', e.message); }
  if (out.geleerteTexte) console.log('[retention] Texte geleert:', out.geleerteTexte);
  if (out.emptied || out.deletedMails || out.deletedErrors || out.deletedDatenwaechter) console.log('[retention]', JSON.stringify(out));
  return out;
}

module.exports = { runRetention, leereAlteTexte };
