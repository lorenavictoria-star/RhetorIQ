// Warteliste «Platz sichern»: Einstellungen, Prüfung der Eingaben, Zähler und Datenzugriff.
// Alle Zahlen sind echt. Freie Plätze = Plätze minus aufgenommene und eingeladene Einträge des Aufnahmefensters minus von Hand vergebene Plätze (zum Beispiel an bestehende Kunden), nie unter 0.
const { pool } = require('../db');
const B = require('./buchung');

const STATUS = ['neu', 'eingeladen', 'aufgenommen', 'abgesagt'];
const STATUS_ZAEHLT = ['eingeladen', 'aufgenommen']; // belegen einen Platz
const TAGESLIMIT = 40;

const STANDARD = { aktiv: false, plaetze: 0, fenster: '', plaetze_zeigen: false, liste_zeigen: false, liste_ab: 5, bereits_vergeben: 0 };
const ganz = (v, min, max, std) => (Number.isInteger(v) && v >= min && v <= max ? v : std);

function einstellungenAus(roh) {
  const o = roh && typeof roh === 'object' ? roh : {};
  return {
    aktiv: o.aktiv === true,
    plaetze: ganz(o.plaetze, 0, 500, STANDARD.plaetze),
    fenster: B.einZeile(o.fenster, 40),
    plaetze_zeigen: o.plaetze_zeigen === true,
    liste_zeigen: o.liste_zeigen === true,
    liste_ab: ganz(o.liste_ab, 0, 1000, STANDARD.liste_ab),
    bereits_vergeben: ganz(o.bereits_vergeben, 0, 500, STANDARD.bereits_vergeben)
  };
}

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS warteliste_einstellungen (advisor_id INTEGER PRIMARY KEY, daten TEXT NOT NULL DEFAULT '{}')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS warteliste (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, unternehmen TEXT NOT NULL DEFAULT '', branche TEXT NOT NULL DEFAULT '',
      anliegen TEXT NOT NULL DEFAULT '', einwilligung BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'neu', monat TEXT NOT NULL DEFAULT '',
      eingeladen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS warteliste_email_idx ON warteliste (email)');
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

async function advisorId() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role='advisor' ORDER BY id LIMIT 1`);
  return rows[0] ? rows[0].id : null;
}

async function einstellungen(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT daten FROM warteliste_einstellungen WHERE advisor_id=$1', [aid]);
  let o = {};
  try { o = rows[0] ? JSON.parse(rows[0].daten) : {}; } catch { o = {}; }
  return einstellungenAus(o);
}
async function einstellungenSpeichern(aid, roh) {
  await ensureSchema();
  const s = einstellungenAus(roh);
  const j = JSON.stringify(s);
  const up = await pool.query('UPDATE warteliste_einstellungen SET daten=$2 WHERE advisor_id=$1', [aid, j]);
  if (!up.rowCount) await pool.query('INSERT INTO warteliste_einstellungen (advisor_id, daten) VALUES ($1,$2)', [aid, j]);
  return s;
}

// Echte Zähler aus der Tabelle
async function zaehler(s) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT status, monat FROM warteliste');
  const belegt = rows.filter(r => STATUS_ZAEHLT.includes(r.status) && r.monat === s.fenster).length;
  const anzahl = rows.filter(r => r.status !== 'abgesagt').length;
  return { belegt, anzahl, frei: Math.max(0, s.plaetze - belegt - s.bereits_vergeben) };
}

// Öffentliche Sicht: bei ausgeschaltetem Schalter nichts ausser aktiv:false. Zähler nur, wenn Lorena sie erlaubt.
async function oeffentlich(aid) {
  const s = await einstellungen(aid);
  if (!s.aktiv) return { aktiv: false };
  const z = await zaehler(s);
  const out = { aktiv: true };
  if (s.plaetze_zeigen && s.plaetze > 0 && s.fenster) { out.plaetze = s.plaetze; out.frei = z.frei; out.fenster = s.fenster; }
  if (s.liste_zeigen && z.anzahl >= s.liste_ab && z.anzahl > 0) out.anzahl = z.anzahl;
  return out;
}

// Eingaben prüfen. Liefert { werte } oder { fehler, feld }
function pruefeEingabe(b, einZeile = B.einZeile) {
  const body = b && typeof b === 'object' ? b : {};
  for (const k of ['name', 'email', 'unternehmen', 'branche', 'anliegen']) {
    if (body[k] != null && typeof body[k] !== 'string') return { fehler: 'Die Angaben sind unvollständig oder ungültig.', feld: k };
  }
  const { pruefeName } = require('./missbrauch');
  const name = pruefeName(body.name, einZeile);
  if (!name) return { fehler: 'Bitte geben Sie Ihren Namen an.', feld: 'name' };
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 120 || !B.EMAIL_RE.test(email)) return { fehler: 'Bitte geben Sie eine gültige E-Mail-Adresse an.', feld: 'email' };
  const unternehmen = einZeile(body.unternehmen, 200);
  if (unternehmen.length < 2 || unternehmen.length > 100 || /[<>]/.test(unternehmen)) return { fehler: 'Bitte geben Sie Ihr Unternehmen an.', feld: 'unternehmen' };
  const branche = einZeile(body.branche, 200);
  if (branche.length < 2 || branche.length > 80 || /[<>]/.test(branche)) return { fehler: 'Bitte geben Sie Ihre Branche an.', feld: 'branche' };
  if (String(body.anliegen || '').length > 3000) return { fehler: 'Das Anliegen ist zu lang. Bitte fassen Sie sich auf höchstens 1000 Zeichen.', feld: 'anliegen' };
  const anliegen = B.mehrzeilig(body.anliegen, 1000);
  if (body.einwilligung !== true) return { fehler: 'Bitte bestätigen Sie die Datenschutzerklärung.', feld: 'einwilligung' };
  return { werte: { name, email, unternehmen, branche, anliegen } };
}

const zeile = (r) => ({ id: r.id, name: r.name, email: r.email, unternehmen: r.unternehmen, branche: r.branche, anliegen: r.anliegen, einwilligung: !!r.einwilligung,
  status: r.status, monat: r.monat, eingeladen_at: r.eingeladen_at, created_at: r.created_at });

// Trägt ein. Liefert { ok, eintrag } | { schon:true } | { status, fehler }
async function eintragen(w, { jetzt = new Date(), monat = '' } = {}) {
  await ensureSchema();
  const vorhanden = await pool.query('SELECT id FROM warteliste WHERE email=$1', [w.email]);
  if (vorhanden.rows.length) return { schon: true };
  const heute = await pool.query('SELECT COUNT(*)::int AS n FROM warteliste WHERE created_at > $1', [new Date(jetzt.getTime() - 24 * 3600000)]);
  if (heute.rows[0].n >= TAGESLIMIT) return { status: 429, fehler: 'Heute sind leider keine weiteren Einträge möglich. Bitte versuchen Sie es morgen noch einmal oder senden Sie mir eine Nachricht.' };
  try {
    const r = await pool.query(
      `INSERT INTO warteliste (name, email, unternehmen, branche, anliegen, einwilligung, status, monat, created_at) VALUES ($1,$2,$3,$4,$5,TRUE,'neu',$6,$7) RETURNING *`,
      [w.name, w.email, w.unternehmen, w.branche, w.anliegen, monat, jetzt]);
    return { ok: true, eintrag: zeile(r.rows[0]) };
  } catch (e) {
    if (e && (e.code === '23505' || /unique|duplicate/i.test(e.message || ''))) return { schon: true };
    throw e;
  }
}

async function liste() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM warteliste ORDER BY created_at DESC, id DESC');
  return rows.map(zeile);
}
async function nachId(id) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM warteliste WHERE id=$1', [id]);
  return rows[0] ? zeile(rows[0]) : null;
}
// Status ändern. Wer eingeladen oder aufgenommen wird, belegt einen Platz im aktuellen Aufnahmefenster.
async function statusSetzen(id, status, fenster = '') {
  await ensureSchema();
  if (!STATUS.includes(status)) return null;
  const e = await nachId(id);
  if (!e) return null;
  if (STATUS_ZAEHLT.includes(status)) {
    await pool.query('UPDATE warteliste SET status=$2, monat=$3, eingeladen_at=COALESCE(eingeladen_at, $4) WHERE id=$1', [id, status, fenster || e.monat, status === 'eingeladen' ? new Date() : null]);
  } else {
    await pool.query('UPDATE warteliste SET status=$2 WHERE id=$1', [id, status]);
  }
  return nachId(id);
}
async function loeschen(id) {
  await ensureSchema();
  const r = await pool.query('DELETE FROM warteliste WHERE id=$1', [id]);
  return r.rowCount > 0;
}

module.exports = { STATUS, STATUS_ZAEHLT, TAGESLIMIT, STANDARD, einstellungenAus, ensureSchema, advisorId, einstellungen, einstellungenSpeichern, zaehler, oeffentlich,
  pruefeEingabe, eintragen, liste, nachId, statusSetzen, loeschen };
