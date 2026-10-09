// Klientendaten vollständig löschen und exportieren (Befund F-10).
// Gelöscht wird in einer Transaktion über alle Tabellen mit Klientenbezug. Neue Tabellen mit Spalte client_id werden
// zusätzlich automatisch gefunden (information_schema), damit nichts stehen bleibt, wenn später eine Tabelle dazukommt.
const JSZip = require('jszip');
const { pool } = require('../db');

// Tabellen, deren Zeilen mit dem Klienten gelöscht werden (Spalte client_id)
const DELETE_TABLES = [
  'analyses', 'company_memory', 'company_memory_history', 'review_requests', 'content_subscriptions',
  'client_module_prompts', 'client_feedback_learnings', 'client_feedback_history', 'client_users',
  'onboarding_tokens', 'usage_topups', 'learning_suggestions', 'custom_modules', 'client_files',
  'onboarding_drafts', 'access_log', 'feedback_notes', 'goldtexte', 'communication_profiles',
  'quartalsreviews', 'ueberarbeitungskarten', 'monatsabschluss', 'themenplan_laeufe', 'durchgang_vergleich',
  'stimmnaehe', 'pruefsatz_laeufe', 'people'
];
// Nur Zahlen ohne Inhalt: der Klientenbezug fällt weg, die Kostensummen bleiben
const ANONYMIZE_TABLES = ['usage_log', 'generation_errors'];
// Tabellen für den Export (ohne Passwörter und Zugangscodes)
const EXPORT_TABLES = DELETE_TABLES.filter(t => t !== 'client_files' && t !== 'onboarding_tokens' && t !== 'access_log');
const SECRET_COLS = new Set(['password_hash', 'token', 'token_version']);

async function existingTables(db) {
  try {
    const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    return new Set(rows.map(r => r.table_name));
  } catch { return null; }
}

async function discoverClientTables(db, known) {
  try {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='client_id'`);
    return rows.map(r => r.table_name).filter(t => !known.has(t) && t !== 'clients');
  } catch { return []; }
}

async function loadClient(db, clientId, advisorId) {
  const { rows } = await db.query('SELECT * FROM clients WHERE id=$1 AND advisor_id=$2', [clientId, advisorId]);
  return rows[0] || null;
}

async function emailsOf(db, client, tables) {
  const list = [client.email];
  if (!tables || tables.has('client_users')) {
    const { rows } = await db.query('SELECT email FROM client_users WHERE client_id=$1', [client.id]);
    rows.forEach(r => list.push(r.email));
  }
  return [...new Set(list.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
}

async function logRequest(kind, advisorId, clientName) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS data_requests_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, kind TEXT, client_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('INSERT INTO data_requests_log (advisor_id, kind, client_name) VALUES ($1,$2,$3)', [advisorId, kind, clientName]);
  } catch (e) { console.error('[clientData] Protokoll:', e.message); }
}

// Klient vollständig löschen. Gibt null zurück, wenn der Klient nicht dieser Beraterin gehört.
async function deleteClientCompletely(clientId, advisorId) {
  const probe = await loadClient(pool, clientId, advisorId);
  if (!probe) return null;
  const db = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const counts = {};
  try {
    await db.query('BEGIN');
    const tables = await existingTables(db);
    const has = (t) => !tables || tables.has(t);
    const client = await loadClient(db, clientId, advisorId);
    const emails = await emailsOf(db, client, tables);

    // Personen: zuerst die Profile
    if (has('people_profiles') && has('people')) {
      const r = await db.query('DELETE FROM people_profiles WHERE person_id IN (SELECT id FROM people WHERE client_id=$1)', [client.id]);
      counts.people_profiles = r.rowCount || 0;
    }
    for (const t of DELETE_TABLES) {
      if (!has(t)) continue;
      const r = await db.query(`DELETE FROM ${t} WHERE client_id=$1`, [client.id]);
      counts[t] = r.rowCount || 0;
    }
    // Automatisch gefundene weitere Tabellen mit client_id
    if (tables) {
      const known = new Set([...DELETE_TABLES, ...ANONYMIZE_TABLES, 'people_profiles']);
      for (const t of await discoverClientTables(db, known)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
        const r = await db.query(`DELETE FROM ${t} WHERE client_id=$1`, [client.id]);
        counts[t] = r.rowCount || 0;
      }
    }
    for (const t of ANONYMIZE_TABLES) {
      if (!has(t)) continue;
      const r = await db.query(`UPDATE ${t} SET client_id=NULL WHERE client_id=$1`, [client.id]);
      counts[t + ' (anonymisiert)'] = r.rowCount || 0;
    }
    // Kopien in den Trainingsbeispielen der Beraterin
    if (has('module_examples')) {
      const r = await db.query('DELETE FROM module_examples WHERE source_client_id=$1', [client.id]);
      counts.module_examples = r.rowCount || 0;
    }
    // Zugeordnet über die E-Mail-Adresse: Warteschlange, Schnelltests, Anfragen aus dem Formular
    if (emails.length) {
      if (has('email_outbox')) counts.email_outbox = (await db.query('DELETE FROM email_outbox WHERE LOWER(to_email) = ANY($1)', [emails])).rowCount || 0;
      if (has('schnelltests')) counts.schnelltests = (await db.query('DELETE FROM schnelltests WHERE LOWER(email) = ANY($1)', [emails])).rowCount || 0;
      if (has('inquiries')) counts.inquiries = (await db.query('DELETE FROM inquiries WHERE LOWER(email) = ANY($1)', [emails])).rowCount || 0;
    }
    counts.clients = (await db.query('DELETE FROM clients WHERE id=$1 AND advisor_id=$2', [client.id, advisorId])).rowCount || 0;
    await db.query('COMMIT');
    console.log(`[clientData] Klient ${client.id} vollständig gelöscht:`, JSON.stringify(counts));
    await logRequest('loeschung', advisorId, client.name);
    return { name: client.name, counts };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    if (db !== pool && typeof db.release === 'function') db.release();
  }
}

// Export: ZIP mit einer JSON-Datei je Tabelle, den hochgeladenen Dateien und einem Word-Dokument mit allen Texten
async function exportClientData(clientId, advisorId) {
  const client = await loadClient(pool, clientId, advisorId);
  if (!client) return null;
  const tables = await existingTables(pool);
  const has = (t) => !tables || tables.has(t);
  const strip = (row) => { const o = {}; for (const k of Object.keys(row)) if (!SECRET_COLS.has(k)) o[k] = row[k]; return o; };
  const zip = new JSZip();
  zip.file('klient.json', JSON.stringify(strip(client), null, 2));
  for (const t of EXPORT_TABLES) {
    if (!has(t)) continue;
    const { rows } = await pool.query(`SELECT * FROM ${t} WHERE client_id=$1`, [client.id]);
    if (rows.length) zip.file(`daten/${t}.json`, JSON.stringify(rows.map(strip), null, 2));
  }
  if (has('people_profiles') && has('people')) {
    const { rows } = await pool.query('SELECT * FROM people_profiles WHERE person_id IN (SELECT id FROM people WHERE client_id=$1)', [client.id]);
    if (rows.length) zip.file('daten/people_profiles.json', JSON.stringify(rows, null, 2));
  }
  if (has('client_files')) {
    const { rows } = await pool.query('SELECT id, folder, name, mime, size, note, created_at, data FROM client_files WHERE client_id=$1', [client.id]);
    const meta = [];
    for (const f of rows) {
      meta.push({ id: f.id, folder: f.folder, name: f.name, mime: f.mime, size: f.size, note: f.note, created_at: f.created_at });
      zip.file(`dateien/${f.folder}/${f.id}_${String(f.name).replace(/[\\/:*?"<>|\r\n]/g, '_')}`, f.data || Buffer.alloc(0));
    }
    if (meta.length) zip.file('daten/client_files.json', JSON.stringify(meta, null, 2));
  }
  if (has('module_examples')) {
    const { rows } = await pool.query('SELECT * FROM module_examples WHERE source_client_id=$1', [client.id]);
    if (rows.length) zip.file('daten/module_examples.json', JSON.stringify(rows, null, 2));
  }
  // Word mit allen Texten
  if (has('analyses')) {
    const { rows } = await pool.query('SELECT created_at, module_label, module, result FROM analyses WHERE client_id=$1 AND result IS NOT NULL ORDER BY created_at', [client.id]);
    zip.file('Texte.docx', await buildTextsDocx(client.name, rows));
  }
  zip.file('LIESMICH.txt', `Datenauszug für ${client.name}, erstellt am ${new Date().toLocaleDateString('de-CH')}.\n\nEnthalten sind eine JSON-Datei je Datenbereich (Ordner daten), die hochgeladenen Dateien (Ordner dateien) und alle Texte als Word-Dokument (Texte.docx). Passwörter und Zugangscodes sind nicht enthalten.\n`);
  await logRequest('export', advisorId, client.name);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, name: client.name };
}

async function buildTextsDocx(clientName, rows) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
  const kids = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`Texte von ${clientName}`)] })];
  for (const r of rows) {
    const d = new Date(r.created_at).toLocaleDateString('de-CH');
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${r.module_label || r.module || 'Text'} · ${d}`)] }));
    String(r.result || '').split(/\r?\n/).forEach(line => kids.push(new Paragraph({ children: [new TextRun(line)] })));
  }
  const doc = new Document({ sections: [{ children: kids }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

module.exports = { deleteClientCompletely, exportClientData, DELETE_TABLES, ANONYMIZE_TABLES };
