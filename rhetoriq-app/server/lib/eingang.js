// Eingang der Beraterin: eine Liste von allem, was neu hereingekommen ist (Freigaben, Anfragen, E-Mails, Termine, Warteliste).
// Reine Datenabfrage ohne KI. Kundentexte und Mailinhalte verlassen den Server nicht.
const { pool } = require('../db');

const MAX_EINTRAEGE = 50;
const TYPEN = ['freigabe', 'anfrage', 'mail', 'termin', 'warteliste'];
const NEU_STUNDEN = 48;

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = pool.query(`CREATE TABLE IF NOT EXISTS inbox_mails (
    id SERIAL PRIMARY KEY, von_name TEXT NOT NULL DEFAULT '', von_adresse TEXT NOT NULL DEFAULT '', an_adresse TEXT NOT NULL DEFAULT '',
    betreff TEXT NOT NULL DEFAULT '', auszug TEXT NOT NULL DEFAULT '', empfangen_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    gelesen_am TIMESTAMPTZ, message_id TEXT UNIQUE)`).catch(e => { ensured = null; throw e; });
  return ensured;
}

// Eine Quelle darf den Eingang nie ganz verhindern
async function sicher(sql, params) { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error('[eingang]', e && e.message); return []; } }

const iso = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const kurz = (t, n) => { const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function fristen(aid, reviews, jetzt) {
  const out = new Map();
  try {
    const D = require('./tagesplanDaten');
    const T = require('./tagesplan');
    const Z = require('./zeit');
    const userLimit = require('./userLimit');
    const [s, ei] = await Promise.all([D.einstellungen(aid), D.eintraege(aid)]);
    const ids = [...new Set(reviews.map(r => Number(r.client_id)))];
    const pk = new Map((ids.length ? await sicher('SELECT id, monthly_token_limit, recommended_plan FROM clients WHERE id = ANY($1::int[])', [ids]) : []).map(c => [Number(c.id), c]));
    for (const r of reviews) {
      const paket = (userLimit.baseFor(pk.get(Number(r.client_id)) || {}).plan) || 'team';
      const f = T.fristBerechnen(new Date(r.created_at), paket, ei, s);
      if (f) { const z = Z.zurich(f); out.set(Number(r.id), `${z.datum === Z.zurich(jetzt).datum ? 'heute' : Z.datumLang(z.datum)}, ${Z.hhmm(z.min)} Uhr`); }
    }
  } catch { /* ohne Frist weiter */ }
  return out;
}

async function eingang(aid, jetzt = new Date()) {
  await ensureSchema();
  // Tabellen der anderen Quellen entstehen sonst erst bei deren erster Nutzung
  for (const m of ['./buchungDaten', './warteliste']) { try { await require(m).ensureSchema(); } catch { /* Quelle bleibt leer */ } }
  const grenzeNeu = new Date(jetzt.getTime() - NEU_STUNDEN * 3600 * 1000);
  const woche = new Date(jetzt.getTime() - 7 * 24 * 3600 * 1000);
  const mailGrenze = new Date(jetzt.getTime() - 30 * 24 * 3600 * 1000);
  const liste = [];

  const rv = await sicher(`SELECT r.id, r.client_id, r.module_label, r.module_key, r.created_at, c.name AS klient
    FROM review_requests r JOIN clients c ON c.id = r.client_id
    WHERE c.advisor_id = $1 AND c.geloescht_am IS NULL AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 100`, [aid]);
  const fr = await fristen(aid, rv, jetzt);
  for (const r of rv) {
    const art = r.module_label || r.module_key || 'Text';
    const frist = fr.get(Number(r.id));
    liste.push({ id: 'freigabe-' + r.id, typ: 'freigabe', titel: kurz(`${r.klient}: ${art}`, 120), info: frist ? `Wartet auf deine Freigabe. Frist ${frist}` : 'Wartet auf deine Freigabe',
      zeit: iso(r.created_at), neu: new Date(r.created_at) >= grenzeNeu, ziel: { ansicht: 'freigaben', reviewId: r.id, clientId: r.client_id } });
  }

  for (const q of await sicher(`SELECT id, name, company, message, created_at FROM inquiries WHERE status = 'neu' ORDER BY created_at DESC LIMIT 100`)) {
    liste.push({ id: 'anfrage-' + q.id, typ: 'anfrage', titel: kurz(q.company ? `${q.name}, ${q.company}` : q.name || 'Anfrage', 120), info: kurz(q.message, 140) || 'Neue Anfrage über die Webseite',
      zeit: iso(q.created_at), neu: true, ziel: { ansicht: 'anfragen', id: q.id } });
  }

  for (const m of await sicher(`SELECT id, von_name, von_adresse, betreff, auszug, empfangen_am, gelesen_am FROM inbox_mails WHERE empfangen_am >= $1 ORDER BY empfangen_am DESC LIMIT 100`, [mailGrenze])) {
    liste.push({ id: 'mail-' + m.id, typ: 'mail', titel: kurz(m.betreff || '(ohne Betreff)', 120), info: kurz(m.von_name ? `${m.von_name} <${m.von_adresse}>` : m.von_adresse, 140),
      zeit: iso(m.empfangen_am), neu: !m.gelesen_am, ziel: { ansicht: 'mail', id: m.id, auszug: m.auszug || '', von: m.von_adresse } });
  }

  for (const b of await sicher(`SELECT id, name, anliegen, datum, beginn, start_at, created_at FROM buchungen
      WHERE advisor_id = $1 AND status = 'gebucht' AND (created_at >= $2 OR start_at >= $3) ORDER BY created_at DESC LIMIT 100`, [aid, woche, jetzt])) {
    const Z = require('./zeit');
    liste.push({ id: 'termin-' + b.id, typ: 'termin', titel: kurz(`Termin mit ${b.name}`, 120), info: `${Z.datumLang(b.datum)}, ${Z.hhmm(b.beginn)} Uhr${b.anliegen ? '. ' + kurz(b.anliegen, 100) : ''}`,
      zeit: iso(b.created_at), neu: new Date(b.created_at) >= grenzeNeu, ziel: { ansicht: 'kalender', datum: b.datum, id: b.id } });
  }

  for (const w of await sicher(`SELECT id, name, unternehmen, anliegen, created_at FROM warteliste WHERE status = 'neu' ORDER BY created_at DESC LIMIT 100`)) {
    liste.push({ id: 'warteliste-' + w.id, typ: 'warteliste', titel: kurz(w.unternehmen ? `${w.name}, ${w.unternehmen}` : w.name, 120), info: kurz(w.anliegen, 140) || 'Neu auf der Warteliste',
      zeit: iso(w.created_at), neu: true, ziel: { ansicht: 'warteliste', id: w.id } });
  }

  const alle = liste.filter(e => e.zeit).sort((a, b) => (a.zeit < b.zeit ? 1 : a.zeit > b.zeit ? -1 : 0));
  const zaehler = { alle: alle.length, freigaben: 0, anfragen: 0, mails: 0, termine: 0, warteliste: 0 };
  const feld = { freigabe: 'freigaben', anfrage: 'anfragen', mail: 'mails', termin: 'termine', warteliste: 'warteliste' };
  for (const e of alle) zaehler[feld[e.typ]]++;
  return { zaehler, eintraege: alle.slice(0, MAX_EINTRAEGE) };
}

async function mailGelesen(id) {
  await ensureSchema();
  const { rowCount } = await pool.query('UPDATE inbox_mails SET gelesen_am = COALESCE(gelesen_am, NOW()) WHERE id = $1', [id]);
  return rowCount > 0;
}

// ── Mail-Empfang ──
const MAX_TEXT = 200000;
function textAus(t) {
  return String(t == null ? '' : t)
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const ADRESSE_RE = /[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]{2,}/g;
function adressen(v) {
  const roh = Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? (x.address || x.email || '') : String(x))).join(',') : (v && typeof v === 'object' ? (v.address || v.email || '') : String(v == null ? '' : v));
  return (roh.match(ADRESSE_RE) || []).map(a => a.toLowerCase());
}
function absender(v) {
  const roh = v && typeof v === 'object' && !Array.isArray(v) ? `${v.name || ''} <${v.address || v.email || ''}>` : String(v == null ? '' : v);
  const a = adressen(roh)[0] || '';
  const name = textAus(roh.replace(ADRESSE_RE, '').replace(/[<>"]/g, '')).slice(0, 200);
  return { name, adresse: a.slice(0, 254) };
}

async function mailSpeichern(roh, zieladresse, jetzt = new Date()) {
  await ensureSchema();
  const an = adressen(roh.an);
  if (!an.includes(String(zieladresse).toLowerCase())) return { gespeichert: false, grund: 'adresse' };
  const von = absender(roh.von);
  if (!von.adresse) return { gespeichert: false, grund: 'absender' };
  const quelle = roh.text != null && String(roh.text).trim() ? roh.text : roh.html;
  const auszug = textAus(String(quelle == null ? '' : quelle).slice(0, MAX_TEXT)).slice(0, 300);
  const betreff = textAus(roh.betreff).slice(0, 300);
  let mid = typeof roh.message_id === 'string' ? roh.message_id.trim().slice(0, 300) : '';
  if (!mid) mid = 'h-' + require('crypto').createHash('sha256').update([von.adresse, betreff, auszug, String(roh.datum || '')].join('|')).digest('hex');
  if ((await pool.query('SELECT 1 FROM inbox_mails WHERE message_id = $1', [mid])).rows[0]) return { gespeichert: false, grund: 'doppelt' };
  try {
    const r = await pool.query(`INSERT INTO inbox_mails (von_name, von_adresse, an_adresse, betreff, auszug, empfangen_am, message_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [von.name, von.adresse, String(zieladresse).toLowerCase(), betreff, auszug, jetzt, mid]);
    return { gespeichert: true, id: r.rows[0].id };
  } catch (e) {
    if (e && (e.code === '23505' || /unique|duplicate/i.test(e.message || ''))) return { gespeichert: false, grund: 'doppelt' }; // gleichzeitige Zustellung
    throw e;
  }
}

module.exports = { ensureSchema, eingang, mailGelesen, mailSpeichern, textAus, adressen, MAX_EINTRAEGE, MAX_TEXT, TYPEN };
