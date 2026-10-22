// Gesamtexport aller Daten der Beraterin als ZIP (JSON je Tabelle), ohne Passwort-Hashes und Zugangscodes.
// Ergänzt das Backup der Datenbank (server/scripts/backup.sh): lesbar ohne Datenbank, auch bei einem Totalausfall.
// Grosse Tabellen werden seitenweise gelesen (nach id), damit der Speicher nicht überläuft.
const JSZip = require('jszip');
const { pool } = require('../db');
const { DELETE_TABLES } = require('./clientData');

const PAGE = 500;
const SECRET_COLS = new Set(['password_hash', 'token', 'token_version', 'secret', 'api_key']);
const isSecret = (k) => SECRET_COLS.has(k) || /_hash$/.test(k) || /_secret$/.test(k);
const strip = (row) => { const o = {}; for (const k of Object.keys(row)) if (!isSecret(k)) o[k] = row[k]; return o; };

// Tabellen mit Spalte client_id. Dateien (client_files) nur als Liste ohne Inhalt, E-Mail-Warteschlange und Zugriffsprotokoll gehören nicht dazu.
const CLIENT_TABLES = [...new Set([...DELETE_TABLES, 'usage_log', 'generation_errors'])]
  .filter(t => !['onboarding_tokens', 'access_log'].includes(t));

async function existingTables() {
  try {
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    return new Set(rows.map(r => r.table_name));
  } catch { return null; }
}

// Liest eine Tabelle seitenweise und gibt den JSON-Text und die Zeilenzahl zurück
async function readPaged(sql, params, idCol = 'id', cols = '*') {
  const parts = [];
  let last = 0, total = 0;
  for (;;) {
    const { rows } = await pool.query(`${sql.replace('{COLS}', cols)} AND ${idCol} > $${params.length + 1} ORDER BY ${idCol} LIMIT ${PAGE}`, [...params, last]);
    if (!rows.length) break;
    for (const r of rows) parts.push(JSON.stringify(strip(r)));
    total += rows.length;
    last = rows[rows.length - 1][idCol];
    if (rows.length < PAGE) break;
  }
  return { text: '[\n' + parts.join(',\n') + '\n]', total };
}

async function buildExportZip(advisorId) {
  const tables = await existingTables();
  const has = t => !tables || tables.has(t);
  const zip = new JSZip();
  const counts = {};
  const scope = 'client_id IN (SELECT id FROM clients WHERE advisor_id=$1)';

  // Klienten (ohne Passwort-Hash und Zugangscode), auch die im Papierkorb
  const cl = await readPaged('SELECT {COLS} FROM clients WHERE advisor_id=$1', [advisorId]);
  zip.file('daten/clients.json', cl.text); counts.clients = cl.total;

  for (const t of CLIENT_TABLES) {
    if (!has(t)) continue;
    const r = await readPaged(`SELECT {COLS} FROM ${t} WHERE ${scope}`, [advisorId]).catch(e => { console.error('[backupExport]', t, e.message); return null; });
    if (r && r.total) { zip.file(`daten/${t}.json`, r.text); counts[t] = r.total; }
  }
  if (has('people_profiles') && has('people')) {
    const r = await readPaged('SELECT {COLS} FROM people_profiles WHERE person_id IN (SELECT id FROM people WHERE client_id IN (SELECT id FROM clients WHERE advisor_id=$1))', [advisorId]).catch(() => null);
    if (r && r.total) { zip.file('daten/people_profiles.json', r.text); counts.people_profiles = r.total; }
  }
  if (has('client_files')) {
    const r = await readPaged(`SELECT {COLS} FROM client_files WHERE ${scope}`, [advisorId], 'id', 'id, client_id, folder, name, mime, size, note, created_at').catch(() => null);
    if (r && r.total) { zip.file('daten/client_files_liste.json', r.text); counts.client_files_liste = r.total; }
  }
  // Eigene Daten der Beraterin: Konto ohne Passwort, Trainingsbeispiele
  if (has('users')) {
    const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id=$1', [advisorId]);
    zip.file('daten/users.json', JSON.stringify(rows, null, 2)); counts.users = rows.length;
  }
  if (has('module_examples')) {
    const r = await readPaged('SELECT {COLS} FROM module_examples WHERE advisor_id=$1', [advisorId]).catch(() => null);
    if (r && r.total) { zip.file('daten/module_examples.json', r.text); counts.module_examples = r.total; }
  }
  const jetzt = new Date();
  zip.file('LIESMICH.txt',
    `Gesamtexport der RhetorIQ-Daten, erstellt am ${jetzt.toLocaleDateString('de-CH')} um ${jetzt.toLocaleTimeString('de-CH')}.\n\n`
    + 'Enthalten ist eine JSON-Datei je Tabelle im Ordner daten. Passwort-Hashes, Zugangscodes und Sitzungsnummern sind entfernt. '
    + 'Hochgeladene Dateien stehen nur als Liste ohne Inhalt darin. Die Datei enthält Klientendaten: verschlüsselt ablegen.\n\n'
    + 'Zeilen je Tabelle:\n' + Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n');
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), counts };
}

module.exports = { buildExportZip, CLIENT_TABLES };
