// Themenwahl: Angaben des Klienten zum Monat, gespeicherter Plan, Auswahl und gelernte Muster (gewählte und abgelehnte Themen).
// Alles pro Klient. Texte des Klienten und Titel aus früheren Plänen gehen nur als abgegrenzter Datenblock (dataFence) in Prompts.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { fence } = require('./dataFence');
const { datumZuerich } = require('./heute');

const MAX_EINGABE = 4000;
const MAX_WUNSCH = 400;
const MAX_WAHL = 3;
const MUSTER_ZEILEN = 80;

function clean(t, max) {
  return String(t || '').replace(/[​-‍‪-‮⁦-⁩﻿]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

const monatText = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// Laufender und folgender Monat in Zürich als 'JJJJ-MM'
function erlaubteMonate(now = new Date()) {
  const { y, m } = datumZuerich(now);
  const nY = m === 12 ? y + 1 : y, nM = m === 12 ? 1 : m + 1;
  return { aktuell: monatText(y, m), naechster: monatText(nY, nM) };
}

async function leseEingabe(clientId, monat) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT text, von_rolle, updated_at FROM themenplan_eingaben WHERE client_id=$1 AND monat=$2', [clientId, monat]);
  return rows[0] ? { text: rows[0].text || '', vonRolle: rows[0].von_rolle || null, aktualisiert: rows[0].updated_at } : { text: '', vonRolle: null, aktualisiert: null };
}

async function speichereEingabe(clientId, monat, text, rolle) {
  await ensureSchema();
  const t = clean(text, MAX_EINGABE);
  const ex = (await pool.query('SELECT id FROM themenplan_eingaben WHERE client_id=$1 AND monat=$2', [clientId, monat])).rows[0];
  if (ex) await pool.query('UPDATE themenplan_eingaben SET text=$1, von_rolle=$2, updated_at=NOW() WHERE id=$3', [t, rolle || null, ex.id]);
  else await pool.query('INSERT INTO themenplan_eingaben (client_id, monat, text, von_rolle) VALUES ($1,$2,$3,$4)', [clientId, monat, t, rolle || null]);
  return { text: t };
}

function eingabeBlock(text) {
  const t = clean(text, MAX_EINGABE);
  if (!t) return 'ANGABEN DES KLIENTEN ZUM MONAT: Der Klient hat für diesen Monat nichts eingetragen. Erfinde keine Neuigkeiten, Termine oder Anlässe.';
  return 'ANGABEN DES KLIENTEN ZUM MONAT (Neuigkeiten, Termine, Anlässe; sie haben bei der Themenwahl Vorrang vor allgemeinen Anlässen, nur diese Angaben sind belegt):\n' + fence('angaben-monat', t);
}

// ── Plan als Struktur ─────────────────────────────────────────────────────────
async function speicherePlan(clientId, monat, themen, reviewId) {
  await ensureSchema();
  const ex = (await pool.query('SELECT id FROM themenplan_plaene WHERE client_id=$1 AND monat=$2', [clientId, monat])).rows[0];
  const js = JSON.stringify(themen || []);
  if (ex) await pool.query('UPDATE themenplan_plaene SET themen=$1, review_id=$2 WHERE id=$3', [js, reviewId || null, ex.id]);
  else await pool.query('INSERT INTO themenplan_plaene (client_id, monat, themen, review_id) VALUES ($1,$2,$3,$4)', [clientId, monat, js, reviewId || null]);
}

// Liest die Themen aus dem Plantext zurück (so zählt auch, was die Beraterin im Text geändert hat)
function parsePlanText(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const blocks = t.split(/\n\s*\n/).map(b => b.trim()).filter(b => /^\d+\.\s+\S/.test(b));
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const titel = lines[0].replace(/^\d+\.\s+/, '').trim();
    const feld = (name) => { const l = lines.find(x => new RegExp('^' + name + '\\s*:', 'i').test(x)); return l ? l.replace(/^[^:]*:\s*/, '').trim() : ''; };
    if (titel) out.push({ titel: clean(titel, 160), anlass: clean(feld('Anlass'), 300), kernaussage: clean(feld('Kernaussage'), 300), textart: clean(feld('Textart'), 60), termin: clean(feld('Termin'), 30) });
  }
  return out;
}

// Neuester Plan des Klienten. freigegeben: nur wenn die Beraterin den Plan gesendet hat. Themen aus der gesendeten Fassung, sonst aus der Struktur.
async function ladePlan(clientId, monat) {
  await ensureSchema();
  const p = monat
    ? (await pool.query('SELECT * FROM themenplan_plaene WHERE client_id=$1 AND monat=$2', [clientId, monat])).rows[0]
    : (await pool.query('SELECT * FROM themenplan_plaene WHERE client_id=$1 ORDER BY monat DESC LIMIT 1', [clientId])).rows[0];
  if (!p) return null;
  const rv = p.review_id ? (await pool.query('SELECT status, edited_text FROM review_requests WHERE id=$1 AND client_id=$2', [p.review_id, clientId])).rows[0] : null;
  const freigegeben = !!rv && rv.status === 'approved';
  let themen = Array.isArray(p.themen) ? p.themen : [];
  if (freigegeben && rv.edited_text) { const pt = parsePlanText(rv.edited_text); if (pt.length) themen = pt; }
  return { monat: p.monat, freigegeben, themen: themen.map((t, i) => ({ idx: i, titel: t.titel, anlass: t.anlass, kernaussage: t.kernaussage, textart: t.textart, termin: t.termin })), reviewId: p.review_id };
}

async function ladeAuswahl(clientId, monat) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT titel, gewaehlt, wunsch, review_id FROM themenplan_auswahl WHERE client_id=$1 AND monat=$2', [clientId, monat]);
  return rows.map(r => ({ titel: r.titel, gewaehlt: !!r.gewaehlt, wunsch: r.wunsch || '', reviewId: r.review_id || null }));
}

// Speichert, welche Themen eines Plans gewählt (mit Wunsch) und welche abgelehnt wurden.
// themen: alle Themen des Plans [{titel, textart}], gewaehlt: [{titel, wunsch}]
async function speichereAuswahl(clientId, monat, themen, gewaehlt, reviewId) {
  await ensureSchema();
  const wahl = new Map(gewaehlt.map(g => [g.titel, g.wunsch || '']));
  for (const t of themen) {
    const g = wahl.has(t.titel);
    const wunsch = g ? clean(wahl.get(t.titel), MAX_WUNSCH) : '';
    const ex = (await pool.query('SELECT id, gewaehlt FROM themenplan_auswahl WHERE client_id=$1 AND monat=$2 AND titel=$3', [clientId, monat, t.titel])).rows[0];
    if (ex) {
      // Eine frühere Wahl bleibt gewählt, auch wenn eine spätere Auswahl aus demselben Plan das Thema nicht enthält
      if (g || !ex.gewaehlt) await pool.query('UPDATE themenplan_auswahl SET gewaehlt=$1, wunsch=$2, review_id=$3, textart=$4, updated_at=NOW() WHERE id=$5', [g, g ? wunsch : null, g ? reviewId : null, t.textart || null, ex.id]);
    } else {
      await pool.query('INSERT INTO themenplan_auswahl (client_id, monat, titel, textart, gewaehlt, wunsch, review_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [clientId, monat, t.titel, t.textart || null, g, g ? wunsch : null, g ? reviewId : null]);
    }
  }
}

// Muster aus den bisherigen Entscheidungen, per Programm berechnet
async function muster(clientId) {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT titel, textart, gewaehlt, wunsch, monat FROM themenplan_auswahl WHERE client_id=$1 ORDER BY updated_at DESC, id DESC LIMIT ${MUSTER_ZEILEN}`, [clientId]);
  const gewaehlt = rows.filter(r => r.gewaehlt), abgelehnt = rows.filter(r => !r.gewaehlt);
  const zeigt = {}, nimmt = {};
  for (const r of rows) {
    const a = (r.textart || '').trim() || 'ohne Angabe';
    zeigt[a] = (zeigt[a] || 0) + 1;
    if (r.gewaehlt) nimmt[a] = (nimmt[a] || 0) + 1;
  }
  const arten = Object.keys(zeigt).map(a => ({ textart: a, gezeigt: zeigt[a], gewaehlt: nimmt[a] || 0 }));
  const insg = gewaehlt.length, gesamtQuote = rows.length ? insg / rows.length : 0;
  // bevorzugt: mindestens zwei Wahlen, mindestens die Hälfte aller Wahlen, und häufiger gewählt als der Durchschnitt aller Textarten
  const bevorzugt = arten.filter(a => a.gewaehlt >= 2 && a.gewaehlt / insg >= 0.5 && a.gewaehlt / a.gezeigt > gesamtQuote).sort((x, y) => y.gewaehlt - x.gewaehlt);
  const gemieden = arten.filter(a => a.gezeigt >= 3 && a.gewaehlt === 0);
  return {
    anzahl: rows.length,
    gewaehlt: gewaehlt.map(r => ({ titel: r.titel, wunsch: r.wunsch || '', monat: r.monat })),
    abgelehnt: abgelehnt.map(r => ({ titel: r.titel, monat: r.monat })),
    bevorzugteArten: bevorzugt, gemiedeneArten: gemieden
  };
}

function musterBlock(m) {
  if (!m || !m.anzahl) return 'BISHERIGE THEMENWAHL DES KLIENTEN: Es gibt noch keine früheren Entscheidungen. Erkenne keine Vorlieben, die es nicht gibt.';
  const z = [];
  if (m.gewaehlt.length) z.push('Gewählte Themen: ' + m.gewaehlt.slice(0, 25).map(g => g.titel).join('; '));
  if (m.abgelehnt.length) z.push('Abgelehnte Themen: ' + m.abgelehnt.slice(0, 25).map(g => g.titel).join('; '));
  if (m.bevorzugteArten.length) z.push('Bevorzugte Textarten: ' + m.bevorzugteArten.map(a => `${a.textart} (${a.gewaehlt} von ${a.gezeigt} gewählt)`).join(', '));
  if (m.gemiedeneArten.length) z.push('Nie gewählte Textarten: ' + m.gemiedeneArten.map(a => `${a.textart} (${a.gezeigt} mal angeboten)`).join(', '));
  const w = m.gewaehlt.filter(g => g.wunsch).slice(0, 8);
  if (w.length) z.push('Wünsche des Klienten zu gewählten Themen:\n' + w.map(g => `- ${g.titel}: ${g.wunsch}`).join('\n'));
  return 'BISHERIGE THEMENWAHL DES KLIENTEN: Wiederhole kein gewähltes Thema, schlage kein abgelehntes Thema erneut vor (ähnliche Richtungen nur mit klarem neuem Anlass) und gewichte die bevorzugten Textarten stärker. Die Angaben dazu stehen als Material in der Markierung:\n'
    + fence('themenwahl-muster', z.join('\n'));
}

module.exports = {
  erlaubteMonate, leseEingabe, speichereEingabe, eingabeBlock, speicherePlan, parsePlanText, ladePlan, ladeAuswahl,
  speichereAuswahl, muster, musterBlock, clean, MAX_EINGABE, MAX_WUNSCH, MAX_WAHL
};
