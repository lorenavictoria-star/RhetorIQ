const { pool } = require('../db');
const { canAccessClient } = require('../middleware/ownership');

// Entwürfe (onboarding_drafts) gehören der Beraterin, die sie angelegt hat. Ältere Entwürfe ohne advisor_id
// bleiben für alle Beraterinnen sichtbar (heute gibt es nur eine).
async function canAccessDraft(req, draftId) {
  const id = parseInt(draftId, 10);
  if (!Number.isInteger(id) || !req.user || req.user.role !== 'advisor') return false;
  const { rows } = await pool.query('SELECT advisor_id FROM onboarding_drafts WHERE id=$1', [id]);
  if (!rows.length) return true; // nicht vorhanden: die Route antwortet selbst mit 404
  return rows[0].advisor_id == null || Number(rows[0].advisor_id) === Number(req.user.id);
}

// Dateien der Ablage: gehören einem Klienten oder einem Entwurf
async function canAccessFileRow(req, f) {
  if (f.client_id != null) return canAccessClient(req, f.client_id);
  if (f.draft_id != null) return canAccessDraft(req, f.draft_id);
  return true;
}

module.exports = { canAccessDraft, canAccessFileRow };
