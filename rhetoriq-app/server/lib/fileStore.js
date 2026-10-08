const { pool } = require('../db');

const FOLDERS = ['entwuerfe', 'workshop', 'unterlagen', 'gesendet'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB je Datei

const cleanName = n => String(n || 'Datei').replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 200) || 'Datei';

// Legt eine Datei in client_files ab und gibt die Zeile ohne data zurück.
async function saveFile({ clientId = null, draftId = null, folder, name, mime, buffer, note = null }) {
  if (!FOLDERS.includes(folder)) throw new Error('Unbekannter Ordner');
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(String(buffer == null ? '' : buffer), 'utf8');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Datei ist grösser als 10 MB');
  const { rows } = await pool.query(
    `INSERT INTO client_files (client_id, draft_id, folder, name, mime, size, data, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, client_id, draft_id, folder, name, mime, size, note, created_at`,
    [clientId, draftId, folder, cleanName(name), String(mime || 'application/octet-stream').slice(0, 120), buffer.length, buffer, note ? String(note).slice(0, 500) : null]
  );
  return rows[0];
}

module.exports = { saveFile, cleanName, FOLDERS, MAX_FILE_BYTES };
