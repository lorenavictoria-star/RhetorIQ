// Datenzugriff für den Tagesplan: Einträge, Einstellungen, Positionen, Kalender-Token, Aufgaben aus den Tabellen.
const crypto = require('crypto');
const { pool } = require('../db');
const Z = require('./zeit');
const T = require('./tagesplan');
const { baueIcs } = require('./ics');

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS tagesplan_eintraege (
      id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, titel TEXT NOT NULL, typ TEXT NOT NULL DEFAULT 'termin',
      datum TEXT NOT NULL, beginn INTEGER, ende INTEGER, ganztaegig BOOLEAN NOT NULL DEFAULT FALSE,
      wiederholung TEXT NOT NULL DEFAULT 'keine', wochentage TEXT NOT NULL DEFAULT '', bis TEXT, notiz TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tagesplan_einstellungen (advisor_id INTEGER PRIMARY KEY, daten TEXT NOT NULL DEFAULT '{}')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tagesplan_token (advisor_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tagesplan_versand (id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, datum TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserviert', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tagesplan_versand_tag_idx ON tagesplan_versand (advisor_id, datum)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tagesplan_positionen (id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, task_key TEXT NOT NULL, datum TEXT NOT NULL, beginn INTEGER NOT NULL)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tagesplan_positionen_key_idx ON tagesplan_positionen (advisor_id, task_key)`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS dringlich BOOLEAN NOT NULL DEFAULT FALSE`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// ── Einstellungen ──
async function einstellungen(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT daten FROM tagesplan_einstellungen WHERE advisor_id=$1', [aid]);
  let o = {};
  try { o = rows[0] ? JSON.parse(rows[0].daten) : {}; } catch { o = {}; }
  return T.einstellungen(o);
}
async function einstellungenSpeichern(aid, roh) {
  await ensureSchema();
  const s = T.einstellungen(roh);
  const j = JSON.stringify(s);
  const up = await pool.query('UPDATE tagesplan_einstellungen SET daten=$2 WHERE advisor_id=$1', [aid, j]);
  if (!up.rowCount) await pool.query('INSERT INTO tagesplan_einstellungen (advisor_id, daten) VALUES ($1,$2)', [aid, j]);
  return s;
}

// ── Einträge ──
function zeile(r) {
  return { id: r.id, titel: r.titel, typ: r.typ, datum: r.datum, beginn: r.beginn, ende: r.ende, ganztaegig: !!r.ganztaegig, wiederholung: r.wiederholung,
    wochentage: String(r.wochentage || '').split(',').filter(Boolean).map(Number), bis: r.bis || null, notiz: r.notiz || '' };
}
async function eintraege(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM tagesplan_eintraege WHERE advisor_id=$1 ORDER BY datum, beginn', [aid]);
  return rows.map(zeile);
}
async function eintragAnlegen(aid, e) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO tagesplan_eintraege (advisor_id, titel, typ, datum, beginn, ende, ganztaegig, wiederholung, wochentage, bis, notiz)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [aid, e.titel, e.typ, e.datum, e.beginn, e.ende, e.ganztaegig, e.wiederholung, e.wochentage.join(','), e.bis, e.notiz]);
  return zeile(rows[0]);
}
async function eintragAendern(aid, id, e) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE tagesplan_eintraege SET titel=$3, typ=$4, datum=$5, beginn=$6, ende=$7, ganztaegig=$8, wiederholung=$9, wochentage=$10, bis=$11, notiz=$12, updated_at=NOW()
     WHERE id=$1 AND advisor_id=$2 RETURNING *`,
    [id, aid, e.titel, e.typ, e.datum, e.beginn, e.ende, e.ganztaegig, e.wiederholung, e.wochentage.join(','), e.bis, e.notiz]);
  return rows[0] ? zeile(rows[0]) : null;
}
async function eintragLoeschen(aid, id) {
  await ensureSchema();
  const { rows } = await pool.query('DELETE FROM tagesplan_eintraege WHERE id=$1 AND advisor_id=$2 RETURNING *', [id, aid]);
  return rows[0] ? zeile(rows[0]) : null;
}

// ── Von Hand verschobene Aufgaben ──
async function positionen(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT task_key, datum, beginn FROM tagesplan_positionen WHERE advisor_id=$1', [aid]);
  const o = {};
  for (const r of rows) o[r.task_key] = { datum: r.datum, beginn: r.beginn };
  return o;
}
async function positionSetzen(aid, key, datum, beginn) {
  await ensureSchema();
  const up = await pool.query('UPDATE tagesplan_positionen SET datum=$3, beginn=$4 WHERE advisor_id=$1 AND task_key=$2', [aid, key, datum, beginn]);
  if (!up.rowCount) await pool.query('INSERT INTO tagesplan_positionen (advisor_id, task_key, datum, beginn) VALUES ($1,$2,$3,$4)', [aid, key, datum, beginn]);
}
async function positionLoeschen(aid, key) {
  await ensureSchema();
  await pool.query('DELETE FROM tagesplan_positionen WHERE advisor_id=$1 AND task_key=$2', [aid, key]);
}

// ── Kalender-Token: nur der Hash wird gespeichert ──
const hashVon = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function tokenErzeugen(aid) {
  await ensureSchema();
  const token = crypto.randomBytes(32).toString('base64url');
  const h = hashVon(token);
  const up = await pool.query('UPDATE tagesplan_token SET token_hash=$2, created_at=NOW() WHERE advisor_id=$1', [aid, h]);
  if (!up.rowCount) await pool.query('INSERT INTO tagesplan_token (advisor_id, token_hash) VALUES ($1,$2)', [aid, h]);
  return token;
}
async function tokenWiderrufen(aid) { await ensureSchema(); await pool.query('DELETE FROM tagesplan_token WHERE advisor_id=$1', [aid]); }
async function tokenStatus(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT created_at FROM tagesplan_token WHERE advisor_id=$1', [aid]);
  return { aktiv: !!rows[0], erstelltAm: rows[0] ? rows[0].created_at : null };
}
async function advisorZuToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  await ensureSchema();
  const { rows } = await pool.query('SELECT advisor_id FROM tagesplan_token WHERE token_hash=$1', [hashVon(token)]);
  return rows[0] ? rows[0].advisor_id : null;
}

// ── Aufgaben ──
const appUrl = () => (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const sicher = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { return []; } };
const gerundet = (m) => Math.max(5, Math.round(m / 5) * 5);

async function dringlichSetzen(aid, reviewId, wert) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE review_requests SET dringlich=$3 WHERE id=$1 AND client_id IN (SELECT id FROM clients WHERE advisor_id=$2) RETURNING id`, [reviewId, aid, !!wert]);
  return !!rows[0];
}

async function aufgaben(aid, settings) {
  await ensureSchema();
  const userLimit = require('./userLimit');
  const out = [];
  const frei = await sicher(`SELECT id, name, monthly_token_limit, recommended_plan FROM clients WHERE advisor_id=$1 AND geloescht_am IS NULL`, [aid]);
  const klienten = new Map(frei.map(c => [Number(c.id), { name: c.name, paket: userLimit.baseFor(c).plan || 'team' }]));
  const hist = await sicher(`SELECT client_id, module_key, module_label, minutes FROM review_requests WHERE minutes IS NOT NULL AND minutes > 0 ORDER BY time_logged_at DESC LIMIT 3000`);
  const mittel = (cid, key, label) => {
    const pick = (f) => hist.filter(h => Number(h.client_id) === Number(cid) && f(h)).slice(0, 10).map(h => Number(h.minutes));
    let l = key ? pick(h => h.module_key === key) : [];
    if (!l.length && label) l = pick(h => h.module_label === label);
    return l.length ? gerundet(l.reduce((a, b) => a + b, 0) / l.length) : null;
  };
  const frg = await sicher(`SELECT r.id, r.client_id, r.module_key, r.module_label, r.created_at, r.dringlich FROM review_requests r JOIN clients c ON c.id=r.client_id
    WHERE c.advisor_id=$1 AND c.geloescht_am IS NULL AND r.status='pending' ORDER BY r.created_at`, [aid]);
  for (const r of frg) {
    const k = klienten.get(Number(r.client_id));
    if (!k) continue;
    const art = r.module_key === 'themenplan' ? 'themenplan' : /newsletter/i.test(r.module_key || '') ? 'newsletter' : 'freigabe';
    const e = mittel(r.client_id, r.module_key, r.module_label);
    out.push({
      key: 'r' + r.id, typ: art === 'themenplan' ? 'themenplan' : 'freigabe', klientId: r.client_id, klient: k.name,
      textart: r.module_label || r.module_key || 'Text', paket: art === 'themenplan' ? null : k.paket, eingang: art === 'themenplan' ? null : new Date(r.created_at),
      dringlich: !!r.dringlich, dauer: e || settings.dauer[art], dauerQuelle: e ? 'erfasst' : 'standard', reviewId: r.id, link: `${appUrl()}/#ws=${r.client_id}`,
      paketFuerRang: k.paket
    });
    if (art === 'themenplan') out[out.length - 1].paket = null;
  }
  for (const q of await sicher(`SELECT id, name, company, created_at FROM inquiries WHERE status='neu' ORDER BY created_at`)) {
    out.push({ key: 'a' + q.id, typ: 'anfrage', klient: q.company || q.name || 'Anfrage', textart: 'Neue Anfrage', paket: null, dringlich: false,
      dauer: settings.dauer.anfrage, dauerQuelle: 'standard', link: `${appUrl()}/` });
  }
  for (const d of await sicher(`SELECT id, firma, kontakt FROM onboarding_drafts WHERE status='bereit' AND (advisor_id IS NULL OR advisor_id=$1)`, [aid])) {
    out.push({ key: 'o' + d.id, typ: 'onboarding', klient: d.firma || d.kontakt || 'Onboarding', textart: 'Onboarding-Entwurf', paket: null, dringlich: false,
      dauer: settings.dauer.onboarding, dauerQuelle: 'standard', link: `${appUrl()}/` });
  }
  for (const l of await sicher(`SELECT l.id, l.client_id, l.quartal FROM quartalsreview_laeufe l JOIN clients c ON c.id=l.client_id WHERE l.status='vorschau' AND c.advisor_id=$1 AND c.geloescht_am IS NULL`, [aid])) {
    const k = klienten.get(Number(l.client_id));
    if (k) out.push({ key: 'q' + l.id, typ: 'auswertung', klientId: l.client_id, klient: k.name, textart: 'Quartalsauswertung ' + l.quartal, paket: null, dringlich: false,
      dauer: settings.dauer.auswertung, dauerQuelle: 'standard', link: `${appUrl()}/#ws=${l.client_id}` });
  }
  for (const v of await sicher(`SELECT v.client_id, v.quartal FROM quartalsreviews v JOIN clients c ON c.id=v.client_id WHERE v.status IN ('versendet','geplant') AND c.advisor_id=$1 AND c.geloescht_am IS NULL`, [aid])) {
    const k = klienten.get(Number(v.client_id));
    if (k) out.push({ key: 'v' + v.client_id + v.quartal, typ: 'quartalsreview', klientId: v.client_id, klient: k.name, textart: 'Quartalsreview', paket: null, dringlich: false,
      dauer: settings.dauer.quartalsreview, dauerQuelle: 'standard', link: `${appUrl()}/#ws=${v.client_id}` });
  }
  // Paket der Anfragen ist unbekannt. Enterprise-Anfragen erkennt die Beraterin über «dringlich» an der Freigabe oder den Hinweis im Text.
  return out;
}

async function planFuer(aid, datum, jetzt = new Date()) {
  const [s, ei, pos] = await Promise.all([einstellungen(aid), eintraege(aid), positionen(aid)]);
  const auf = await aufgaben(aid, s);
  const plan = T.planBauen(auf, { datum, eintraege: ei, settings: s, jetzt, positionen: pos });
  plan.text = T.planText(plan);
  return plan;
}

// Kalenderereignisse für den Feed und die Mail: Plan-Aufgaben (und optional Termine) eines Tages
function planEreignisse(plan, { termine = false, jetzt = new Date() } = {}) {
  const seq = Math.floor(jetzt.getTime() / 60000);
  const ev = plan.items.map(i => ({
    uid: `rq-${i.key}@rhetoriq.ch`, datum: plan.datum, beginn: i.beginn, ende: i.ende, ganztaegig: false, titel: i.titel, sequenz: seq,
    beschreibung: `Dauer ${T.dauerText(i.dauer)}${i.fristText ? '. Frist: ' + i.fristText : ''}${i.paketName ? '. Paket: ' + i.paketName : ''}${i.verspaetet ? '. Die Frist wird nicht gehalten.' : ''}`,
    url: i.link
  }));
  if (termine) for (const b of plan.bloecke) ev.push({ uid: `rq-e${b.id}-${plan.datum}@rhetoriq.ch`, datum: plan.datum, beginn: b.beginn, ende: b.ende, ganztaegig: b.ganztaegig, titel: b.titel, beschreibung: b.notiz || '', sequenz: seq });
  return ev;
}
async function icsFuerTag(aid, datum, { abo = false, jetzt = new Date() } = {}) {
  const plan = await planFuer(aid, datum, jetzt);
  return { plan, ics: baueIcs(planEreignisse(plan, { termine: abo, jetzt }), { jetzt, abo }) };
}

module.exports = { ensureSchema, einstellungen, einstellungenSpeichern, eintraege, eintragAnlegen, eintragAendern, eintragLoeschen, positionen, positionSetzen, positionLoeschen,
  tokenErzeugen, tokenWiderrufen, tokenStatus, advisorZuToken, hashVon, dringlichSetzen, aufgaben, planFuer, planEreignisse, icsFuerTag, appUrl };
