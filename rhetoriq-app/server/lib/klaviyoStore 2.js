// Serverseitige, verschlüsselte Ablage der privaten Klaviyo-Schlüssel (je Klient oder je Beraterin).
// Der Schlüssel verlässt diese Datei nur über lade() und nur für Aufrufe an Klaviyo. Er wird nie zurückgegeben, geloggt oder angezeigt.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const secretBox = require('./secretBox');

const KINDS = ['client', 'advisor'];
function kindOk(k) { if (!KINDS.includes(k)) throw new Error('Unbekannte Ablage'); }

// Status ohne Schlüssel
async function status(kind, id) {
  kindOk(kind);
  await ensureSchema();
  const { rows } = await pool.query('SELECT rechte, geprueft_am FROM klaviyo_zugang WHERE owner_kind=$1 AND owner_id=$2', [kind, id]);
  const r = rows[0];
  return { konfiguriert: secretBox.available(), verbunden: !!r, geprueftAm: r ? r.geprueft_am : null, rechte: r ? r.rechte : null };
}

// Speichert (ersetzt) den Schlüssel verschlüsselt. Wirft Fehler mit code NO_SECRET, wenn die Verschlüsselung fehlt.
async function speichere(kind, id, apiKey, rechte) {
  kindOk(kind);
  await ensureSchema();
  const enc = secretBox.encrypt(apiKey);
  const rj = rechte ? JSON.stringify(rechte) : null;
  const ex = (await pool.query('SELECT id FROM klaviyo_zugang WHERE owner_kind=$1 AND owner_id=$2', [kind, id])).rows[0];
  if (ex) await pool.query('UPDATE klaviyo_zugang SET key_enc=$1, rechte=$2, geprueft_am=NOW(), updated_at=NOW() WHERE id=$3', [enc, rj, ex.id]);
  else await pool.query('INSERT INTO klaviyo_zugang (owner_kind, owner_id, key_enc, rechte, geprueft_am) VALUES ($1,$2,$3,$4,NOW())', [kind, id, enc, rj]);
}

// Gibt den Klartext-Schlüssel für einen Aufruf an Klaviyo zurück, oder null (nichts gespeichert oder nicht lesbar)
async function lade(kind, id) {
  kindOk(kind);
  await ensureSchema();
  const { rows } = await pool.query('SELECT key_enc FROM klaviyo_zugang WHERE owner_kind=$1 AND owner_id=$2', [kind, id]);
  if (!rows[0]) return null;
  try { return secretBox.decrypt(rows[0].key_enc); } catch { return null; }
}

async function aktualisiereRechte(kind, id, rechte) {
  kindOk(kind);
  await pool.query('UPDATE klaviyo_zugang SET rechte=$1, geprueft_am=NOW(), updated_at=NOW() WHERE owner_kind=$2 AND owner_id=$3', [rechte ? JSON.stringify(rechte) : null, kind, id]);
}

async function loesche(kind, id) {
  kindOk(kind);
  await ensureSchema();
  await pool.query('DELETE FROM klaviyo_zugang WHERE owner_kind=$1 AND owner_id=$2', [kind, id]);
}

module.exports = { status, speichere, lade, aktualisiereRechte, loesche };
