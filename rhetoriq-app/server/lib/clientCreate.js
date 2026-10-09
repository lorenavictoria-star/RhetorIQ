const crypto = require('crypto');
const { pool } = require('../db');

// Best-effort classification for clients created before client_type was
// persisted, or wherever it's genuinely unknown. "Joanne Sieber" (two
// capitalised words, no digits/suffix) reads as an individual; "FLAGA" or
// "3rd May" (a single word, or containing a digit) reads as a company.
// Never perfect, but far better than always defaulting to "company".
function guessClientType(name) {
  if (!name) return 'company';
  const trimmed = name.trim();
  const companySuffixes = /\b(AG|GmbH|SA|Sarl|Ltd|LLC|Inc|Corp|KG|SE|PLC|Co\.?|Group|Holding|Genossenschaft|Stiftung)\b/i;
  if (companySuffixes.test(trimmed)) return 'company';
  const words = trimmed.split(/\s+/);
  const looksLikePersonalName = words.length === 2 && words.every(w => /^[A-ZÄÖÜ][a-zäöüß'-]+$/.test(w));
  return looksLikePersonalName ? 'individual' : 'company';
}
// Split a company/individual display name into a plausible last name for
// the salutation, when no explicit last_name was stored (legacy clients).
function guessLastName(name) {
  if (!name) return '';
  const words = name.trim().split(/\s+/);
  return words[words.length - 1];
}


// Legt einen Klienten an (gemeinsame Logik für POST /api/clients und den Abschluss eines Onboarding-Entwurfs).
// Prüfungen (Name, E-Mail, Datenschutz) und der Versand von Mails bleiben bei den Aufrufern.
async function createClientRecord({ advisorId, name, industry, contact, email, clientType, salutation, lastName, enabledModules, paket }) {
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36);
  const token = crypto.randomBytes(24).toString('hex');

  const mods = Array.isArray(enabledModules) && enabledModules.length ? enabledModules : null;
  // Persist client_type/salutation/last_name so every future email (not
  // just this first one) addresses this client correctly, instead of
  // relying on each call site to pass it fresh — falls back to a
  // name-based guess if the advisor didn't specify it explicitly.
  const resolvedType = clientType || guessClientType(name);
  const resolvedLastName = lastName || (resolvedType === 'individual' ? guessLastName(name) : '');
  const { rows } = await pool.query(
    'INSERT INTO clients (advisor_id, name, industry, contact, slug, token, email, must_change_password, privacy_acknowledged_at, enabled_modules, client_type, salutation, last_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12) RETURNING *',
    [advisorId, name, industry || '', contact || '', slug, token, email || null, !!email, mods, resolvedType, salutation || 'Frau', resolvedLastName]
  );
  // Standardkontingent für NEU angelegte Klienten (Befund F-07): ohne gesetztes Limit und ausser im Paket Enterprise
  // gelten monatlich 200000 Tokens (per DEFAULT_MONTHLY_TOKENS änderbar). Das Paket per Zahlung ersetzt den Wert später.
  if (paket !== 'enterprise' && !rows[0].monthly_token_limit) {
    const def = parseInt(process.env.DEFAULT_MONTHLY_TOKENS, 10) || 200000;
    try {
      await pool.query('UPDATE clients SET monthly_token_limit=$1 WHERE id=$2 AND monthly_token_limit IS NULL', [def, rows[0].id]);
      rows[0].monthly_token_limit = def;
    } catch (e) { console.error('[clientCreate] Standardkontingent:', e.message); }
  }
  return { row: rows[0], resolvedType, resolvedLastName };
}

module.exports = { guessClientType, guessLastName, createClientRecord };
