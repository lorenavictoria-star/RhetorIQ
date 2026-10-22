// Technische Vorbereitung auf Transparenzpflichten bei KI-Texten (keine Rechtsaussage):
// Metadaten in Word-Dokumenten und ein optionaler Hinweis-Satz je Klient (Standard: aus).
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');

const KI_FELD = 'Erstellt mit KI-Unterstützung (RhetorIQ)';
const KI_SATZ = 'Dieser Text wurde mit KI-Unterstützung erstellt und von Menschen geprüft.';

// Zusätzliche Optionen für new Document(...) der docx-Bibliothek
function docMeta() {
  return { description: KI_FELD, customProperties: [{ name: 'KI-Unterstützung', value: KI_FELD }] };
}

function hinweisParagraph(docx) {
  return new docx.Paragraph({
    spacing: { before: 360 },
    children: [new docx.TextRun({ text: KI_SATZ, size: 18, color: '666666' })]
  });
}

async function getFlag(clientId) {
  const id = parseInt(clientId, 10);
  if (!Number.isInteger(id)) return false;
  await ensureSchema();
  const { rows } = await pool.query('SELECT ki_hinweis FROM clients WHERE id=$1', [id]);
  return !!(rows[0] && rows[0].ki_hinweis);
}

// Klienten: immer die eigene Einstellung. Beraterin: die des angegebenen Klienten, wenn er ihr gehört.
async function flagForRequest(req, requestedClientId) {
  try {
    if (!req.user) return false;
    if (req.user.role === 'client') return await getFlag(req.user.clientId);
    if (req.user.role === 'advisor' && requestedClientId != null && requestedClientId !== '') {
      const { canAccessClient } = require('../middleware/ownership');
      if (await canAccessClient(req, requestedClientId)) return await getFlag(requestedClientId);
    }
  } catch (e) { console.error('[ki-hinweis]', e.message); }
  return false;
}

module.exports = { KI_FELD, KI_SATZ, docMeta, hinweisParagraph, getFlag, flagForRequest };
