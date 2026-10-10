// Tabellen und Datenzugriff der Kalender-Synchronisation (Google und Besetzt-Zeiten aus fremden Kalendern).
//  kalender_google        Verbindung pro Beraterin: verschlüsseltes Refresh-Token, Kalender-ID, Sync-Token, Webhook-Kanal
//  kalender_google_state  einmalige OAuth-Zustände (CSRF-Schutz, PKCE)
//  kalender_google_map    Verknüpfung UID in RhetorIQ <-> Ereignis-ID bei Google
//  kalender_ausgeblendet  Plan-Aufgaben, die am Handy gelöscht wurden (nur für den Tag ausgeblendet)
//  kalender_fremd         ICS-Links anderer Kalender (verschlüsselt) und zuletzt gelesene Termine
const crypto = require('crypto');
const { pool } = require('../../db');

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS kalender_google (
      advisor_id INTEGER PRIMARY KEY, refresh_enc TEXT NOT NULL, calendar_id TEXT, sync_token TEXT,
      channel_id TEXT, channel_token_hash TEXT, channel_resource TEXT, channel_ablauf TIMESTAMPTZ,
      letzte_sync TIMESTAMPTZ, fehler TEXT, fehler_seit TIMESTAMPTZ, verbunden_am TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS kalender_google_state (
      state_hash TEXT PRIMARY KEY, advisor_id INTEGER NOT NULL, bindung_hash TEXT NOT NULL, verifier_enc TEXT NOT NULL,
      ablauf TIMESTAMPTZ NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS kalender_google_map (
      id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, uid TEXT NOT NULL, google_id TEXT NOT NULL, art TEXT NOT NULL,
      eintrag_id INTEGER, task_key TEXT, datum TEXT, beginn INTEGER, ende INTEGER, etag TEXT, hash TEXT, kern TEXT, google_updated TEXT)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS kalender_google_map_uid_idx ON kalender_google_map (advisor_id, uid)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS kalender_google_map_gid_idx ON kalender_google_map (advisor_id, google_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS kalender_ausgeblendet (advisor_id INTEGER NOT NULL, task_key TEXT NOT NULL, datum TEXT NOT NULL)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS kalender_ausgeblendet_idx ON kalender_ausgeblendet (advisor_id, task_key, datum)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS kalender_fremd (
      id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, bezeichnung TEXT NOT NULL, url_enc TEXT NOT NULL, farbe TEXT NOT NULL DEFAULT '#8a8f98',
      aktiv BOOLEAN NOT NULL DEFAULT TRUE, etag TEXT, last_modified TEXT, ereignisse TEXT NOT NULL DEFAULT '[]',
      abgerufen_am TIMESTAMPTZ, erfolg_am TIMESTAMPTZ, fehler TEXT, fehler_seit TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const zufall = (n = 32) => crypto.randomBytes(n).toString('base64url');

// ── Google-Verbindung ──
const SPALTEN = ['refresh_enc', 'calendar_id', 'sync_token', 'channel_id', 'channel_token_hash', 'channel_resource', 'channel_ablauf', 'letzte_sync', 'fehler', 'fehler_seit'];
async function googleZeile(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM kalender_google WHERE advisor_id=$1', [aid]);
  return rows[0] || null;
}
async function googleAlle() {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_google ORDER BY advisor_id')).rows;
}
async function googleSetzen(aid, felder) {
  await ensureSchema();
  const keys = Object.keys(felder).filter(k => SPALTEN.includes(k));
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  await pool.query(`UPDATE kalender_google SET ${set} WHERE advisor_id=$1`, [aid, ...keys.map(k => felder[k])]);
}
async function googleVerbinden(aid, refreshEnc, calendarId) {
  await ensureSchema();
  const up = await pool.query(
    `UPDATE kalender_google SET refresh_enc=$2, calendar_id=$3, sync_token=NULL, channel_id=NULL, channel_token_hash=NULL, channel_resource=NULL, channel_ablauf=NULL,
     fehler=NULL, fehler_seit=NULL, verbunden_am=NOW() WHERE advisor_id=$1`, [aid, refreshEnc, calendarId]);
  if (!up.rowCount) await pool.query('INSERT INTO kalender_google (advisor_id, refresh_enc, calendar_id) VALUES ($1,$2,$3)', [aid, refreshEnc, calendarId]);
}
async function googleLoeschen(aid) {
  await ensureSchema();
  await pool.query('DELETE FROM kalender_google WHERE advisor_id=$1', [aid]);
  await pool.query('DELETE FROM kalender_google_map WHERE advisor_id=$1', [aid]);
  await pool.query('DELETE FROM kalender_google_state WHERE advisor_id=$1', [aid]);
}
async function kanalZuId(channelId) {
  await ensureSchema();
  if (typeof channelId !== 'string' || !channelId) return null;
  const { rows } = await pool.query('SELECT * FROM kalender_google WHERE channel_id=$1', [channelId]);
  return rows[0] || null;
}

// ── OAuth-Zustand: einmalig, 10 Minuten gültig, an Beraterin und Browser gebunden ──
async function stateAnlegen(aid, state, bindung, verifierEnc, minuten = 10) {
  await ensureSchema();
  await pool.query('DELETE FROM kalender_google_state WHERE ablauf < NOW()');
  await pool.query('INSERT INTO kalender_google_state (state_hash, advisor_id, bindung_hash, verifier_enc, ablauf) VALUES ($1,$2,$3,$4,$5)',
    [sha(state), aid, sha(bindung), verifierEnc, new Date(Date.now() + minuten * 60000)]);
}
// Löst den Zustand ein und löscht ihn in jedem Fall (einmalige Verwendung). Liefert { advisorId, verifierEnc } oder null.
async function stateEinloesen(state, bindung) {
  await ensureSchema();
  if (typeof state !== 'string' || !state) return null;
  const { rows } = await pool.query('DELETE FROM kalender_google_state WHERE state_hash=$1 RETURNING *', [sha(state)]);
  const r = rows[0];
  if (!r) return null;
  if (new Date(r.ablauf).getTime() < Date.now()) return null;
  const a = Buffer.from(sha(bindung || '')), b = Buffer.from(r.bindung_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { advisorId: r.advisor_id, verifierEnc: r.verifier_enc };
}

// ── Verknüpfung ──
async function mapHole(aid, uid) {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_google_map WHERE advisor_id=$1 AND uid=$2', [aid, uid])).rows[0] || null;
}
async function mapNachGoogleId(aid, gid) {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_google_map WHERE advisor_id=$1 AND google_id=$2', [aid, gid])).rows[0] || null;
}
async function mapAlle(aid) {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_google_map WHERE advisor_id=$1', [aid])).rows;
}
async function mapSetzen(aid, m) {
  await ensureSchema();
  const v = [aid, m.uid, m.google_id, m.art, m.eintrag_id ?? null, m.task_key ?? null, m.datum ?? null, m.beginn ?? null, m.ende ?? null, m.etag ?? null, m.hash ?? null, m.google_updated ?? null, m.kern ?? null];
  const up = await pool.query(
    `UPDATE kalender_google_map SET google_id=$3, art=$4, eintrag_id=$5, task_key=$6, datum=$7, beginn=$8, ende=$9, etag=$10, hash=$11, google_updated=$12, kern=$13
     WHERE advisor_id=$1 AND uid=$2`, v);
  if (!up.rowCount) await pool.query(
    `INSERT INTO kalender_google_map (advisor_id, uid, google_id, art, eintrag_id, task_key, datum, beginn, ende, etag, hash, google_updated, kern) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, v);
}
async function mapLoeschen(aid, uid) {
  await ensureSchema();
  await pool.query('DELETE FROM kalender_google_map WHERE advisor_id=$1 AND uid=$2', [aid, uid]);
}

// ── Ausgeblendete Plan-Aufgaben ──
async function ausblenden(aid, key, datum) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT 1 FROM kalender_ausgeblendet WHERE advisor_id=$1 AND task_key=$2 AND datum=$3', [aid, key, datum]);
  if (!rows[0]) await pool.query('INSERT INTO kalender_ausgeblendet (advisor_id, task_key, datum) VALUES ($1,$2,$3)', [aid, key, datum]);
}
async function ausgeblendetAm(aid, datum) {
  await ensureSchema();
  return new Set((await pool.query('SELECT task_key FROM kalender_ausgeblendet WHERE advisor_id=$1 AND datum=$2', [aid, datum])).rows.map(r => r.task_key));
}
async function einblendenAlle(aid, datum) {
  await ensureSchema();
  const r = await pool.query('DELETE FROM kalender_ausgeblendet WHERE advisor_id=$1 AND datum=$2', [aid, datum]);
  await pool.query('DELETE FROM kalender_ausgeblendet WHERE datum < $1', [datum]);
  return r.rowCount || 0;
}

// ── Fremde Kalender ──
const fremdOeffentlich = (r) => ({ id: r.id, bezeichnung: r.bezeichnung, farbe: r.farbe, aktiv: !!r.aktiv, abgerufenAm: r.abgerufen_am, erfolgAm: r.erfolg_am, fehler: r.fehler || null, fehlerSeit: r.fehler_seit || null });
async function fremdAlle(aid) {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_fremd WHERE advisor_id=$1 ORDER BY id', [aid])).rows;
}
async function fremdAlleAktiven() {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_fremd WHERE aktiv=TRUE ORDER BY id')).rows;
}
async function fremdHole(aid, id) {
  await ensureSchema();
  return (await pool.query('SELECT * FROM kalender_fremd WHERE advisor_id=$1 AND id=$2', [aid, id])).rows[0] || null;
}
async function fremdAnlegen(aid, bezeichnung, urlEnc, farbe) {
  await ensureSchema();
  return (await pool.query('INSERT INTO kalender_fremd (advisor_id, bezeichnung, url_enc, farbe) VALUES ($1,$2,$3,$4) RETURNING *', [aid, bezeichnung, urlEnc, farbe])).rows[0];
}
async function fremdAendern(aid, id, felder) {
  await ensureSchema();
  const erlaubt = ['bezeichnung', 'farbe', 'aktiv'];
  const keys = Object.keys(felder).filter(k => erlaubt.includes(k));
  if (!keys.length) return fremdHole(aid, id);
  const set = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  const { rows } = await pool.query(`UPDATE kalender_fremd SET ${set} WHERE advisor_id=$1 AND id=$2 RETURNING *`, [aid, id, ...keys.map(k => felder[k])]);
  return rows[0] || null;
}
async function fremdLoeschen(aid, id) {
  await ensureSchema();
  const r = await pool.query('DELETE FROM kalender_fremd WHERE advisor_id=$1 AND id=$2', [aid, id]);
  return (r.rowCount || 0) > 0;
}
// Ergebnis eines Abrufs. ok: neue Daten (ereignisse JSON) oder unverändert (ereignisse undefined). Sonst Fehlertext.
async function fremdErgebnis(id, { ok, fehler, ereignisse, etag, lastModified }) {
  await ensureSchema();
  if (ok) {
    if (ereignisse !== undefined) {
      await pool.query('UPDATE kalender_fremd SET ereignisse=$2, etag=$3, last_modified=$4, abgerufen_am=NOW(), erfolg_am=NOW(), fehler=NULL, fehler_seit=NULL WHERE id=$1', [id, ereignisse, etag || null, lastModified || null]);
    } else {
      await pool.query('UPDATE kalender_fremd SET abgerufen_am=NOW(), erfolg_am=NOW(), fehler=NULL, fehler_seit=NULL WHERE id=$1', [id]);
    }
  } else {
    await pool.query('UPDATE kalender_fremd SET abgerufen_am=NOW(), fehler=$2, fehler_seit=COALESCE(fehler_seit, NOW()) WHERE id=$1', [id, String(fehler || 'Fehler').slice(0, 200)]);
  }
}

module.exports = {
  ensureSchema, sha, zufall, googleZeile, googleAlle, googleSetzen, googleVerbinden, googleLoeschen, kanalZuId,
  stateAnlegen, stateEinloesen, mapHole, mapNachGoogleId, mapAlle, mapSetzen, mapLoeschen,
  ausblenden, ausgeblendetAm, einblendenAlle, fremdOeffentlich, fremdAlle, fremdAlleAktiven, fremdHole, fremdAnlegen, fremdAendern, fremdLoeschen, fremdErgebnis
};
