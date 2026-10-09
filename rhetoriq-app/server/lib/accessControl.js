const crypto = require('crypto');
const { pool } = require('../db');

// Sitzungsdauer der Klienten und ihrer Teammitglieder (Beraterin: 30 Tage, siehe routes/auth.js)
const CLIENT_SESSION = '30d';
const TEAM_ROLES = ['admin', 'editor', 'viewer'];

// Alle Sitzungen des Klienten und seiner Teammitglieder beenden. Der Zugangscode bleibt gleich.
async function logoutClientDevices(clientId, advisorId) {
  const { rows } = await pool.query(
    'UPDATE clients SET token_version = token_version + 1 WHERE id=$1 AND advisor_id=$2 RETURNING id',
    [clientId, advisorId]
  );
  if (!rows.length) return null;
  await pool.query('UPDATE client_users SET token_version = token_version + 1 WHERE client_id=$1', [clientId]);
  return { id: rows[0].id };
}

// Zugang entziehen: alle Sitzungen beenden UND einen neuen Zugangscode erzeugen. Der alte Code funktioniert danach nicht mehr.
// Mit resetPassword wird zusätzlich das Passwort des Hauptzugangs gelöscht (Anmeldung dann nur mit dem neuen Code
// oder nach neuem Passwort).
async function revokeClientAccess(clientId, advisorId, { resetPassword = false } = {}) {
  const newToken = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `UPDATE clients SET token_version = token_version + 1, token = $3${resetPassword ? ', password_hash = NULL' : ''}
     WHERE id=$1 AND advisor_id=$2 RETURNING id`,
    [clientId, advisorId, newToken]
  );
  if (!rows.length) return null;
  await pool.query('UPDATE client_users SET token_version = token_version + 1 WHERE client_id=$1', [clientId]);
  return { id: rows[0].id, token: newToken };
}

module.exports = { CLIENT_SESSION, TEAM_ROLES, logoutClientDevices, revokeClientAccess };
