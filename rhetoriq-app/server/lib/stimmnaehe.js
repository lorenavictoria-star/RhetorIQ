// Stimmnähe (Stufe 2 aus «Messen statt hoffen»): Wie nah liegt ein Text an den Kennzahlen des Referenzmaterials
// des Klienten? Alles wird lokal berechnet, ohne KI-Aufruf. Das Ergebnis ist eine Zahl von 0 bis 100.
// Der Wert ist eine Näherung aus sechs zählbaren Merkmalen und ersetzt kein Urteil nach dem Hören oder Lesen.
const { pool } = require('../db');
const { computeMetrics } = require('./commProfile');

// Gewichte der Merkmale (Summe 1). Der Wortschatz trägt am meisten, weil er den Klienten am deutlichsten
// von einem neutralen Text unterscheidet. Satzlänge und Absatzlänge bilden den Rhythmus, die Anrede ist
// ein klares Entweder-oder, lange Sätze und typische Wendungen sind feinere Hinweise.
const GEWICHTE = {
  satzlaenge: 0.22,    // durchschnittliche Wörter je Satz
  langeSaetze: 0.10,   // Anteil Sätze über 25 Wörter
  anrede: 0.15,        // Sie, Du oder keine Anrede
  wortschatz: 0.25,    // Überlappung der Inhaltswörter mit dem Referenzmaterial
  wendungen: 0.13,     // typische Wendungen des Klienten (aus computeMetrics)
  absatz: 0.15         // Sätze je Absatz
};
// Toleranzen: ab dieser Abweichung ist die Nähe des Merkmals null
const TOL = { satzlaengeRel: 0.6, satzlaengeMin: 4, langeSaetze: 0.35, absatzRel: 0.6, absatzMin: 1.5 };
const MIN_WOERTER = 30;         // kürzere Texte haben zu wenig Substanz für eine Zahl
const MIN_REF_ZEICHEN = 300;    // weniger Referenzmaterial ergibt keine verlässliche Zahl
const MAX_REF_ZEICHEN = 60000;
const TEXT_MODULES = ['text-gen', 'brief', 'ghostwriter', 'before-after'];

const STOP = new Set(['der', 'die', 'das', 'und', 'ist', 'wir', 'sie', 'ihr', 'ihre', 'ein', 'eine', 'zu', 'in', 'im', 'von', 'mit', 'für', 'auf', 'den', 'dem', 'des', 'es', 'sich', 'auch', 'als', 'an', 'bei', 'wird', 'sind', 'nicht', 'ich', 'dass', 'oder', 'aber', 'wenn', 'dann', 'noch', 'nur', 'sehr', 'mehr', 'diese', 'dieser', 'haben', 'werden', 'wurde', 'kann', 'können', 'ihnen', 'ihrer', 'unser', 'unsere', 'uns']);

const woerter = t => String(t || '').toLowerCase().match(/[a-zäöüéèàß0-9]+/g) || [];
const saetze = t => String(t || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => woerter(s).length >= 3);
const absaetze = t => String(t || '').split(/\n\s*\n/).map(s => s.trim()).filter(s => saetze(s).length);
const stamm = w => w.slice(0, 5);
const inhaltsStaemme = t => woerter(t).filter(w => w.length >= 4 && !STOP.has(w)).map(stamm);

function anredeVon(t) {
  const x = String(t || '');
  const sie = (x.match(/\b(Sie|Ihnen|Ihr|Ihre|Ihrer|Ihren|Ihrem)\b/g) || []).length;
  const du = (x.match(/\b(du|dir|dich|dein|deine|deiner|deinen|deinem)\b/gi) || []).length;
  if (sie === 0 && du === 0) return 'keine';
  return sie >= du ? 'sie' : 'du';
}

// Kennzahlen eines Textes (oder mehrerer Texte)
function kennzahlen(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const all = list.join('\n\n');
  const m = computeMetrics(list);
  const abs = list.flatMap(absaetze);
  const proAbsatz = abs.length ? abs.reduce((a, p) => a + saetze(p).length, 0) / abs.length : 0;
  return {
    woerter: woerter(all).length,
    satzlaenge: m.avgSentenceLength,
    langeSaetze: m.longSentenceShare / 100,
    anrede: anredeVon(all),
    absatz: Math.round(proAbsatz * 10) / 10,
    wendungen: m.topPhrases.map(p => p.phrase)
  };
}

const naehe = (a, b, tol) => Math.max(0, 1 - Math.abs(a - b) / tol);

// Vergleicht einen Text mit dem Referenzmaterial. Gibt { wert, merkmale } zurück oder null, wenn eine Seite zu wenig hergibt.
function stimmnaehe(text, referenzTexte) {
  const refs = (referenzTexte || []).map(t => String(t || '').trim()).filter(Boolean);
  if (refs.join('').length < MIN_REF_ZEICHEN) return null;
  const t = kennzahlen(text);
  if (t.woerter < MIN_WOERTER) return null;
  const r = kennzahlen(refs);
  const refVocab = new Set(refs.flatMap(inhaltsStaemme));
  const tv = inhaltsStaemme(text);

  const f = {};
  f.satzlaenge = { wert: t.satzlaenge, referenz: r.satzlaenge, naehe: naehe(t.satzlaenge, r.satzlaenge, Math.max(TOL.satzlaengeMin, TOL.satzlaengeRel * r.satzlaenge)) };
  f.langeSaetze = { wert: Math.round(t.langeSaetze * 100), referenz: Math.round(r.langeSaetze * 100), naehe: naehe(t.langeSaetze, r.langeSaetze, TOL.langeSaetze) };
  f.anrede = { wert: t.anrede, referenz: r.anrede, naehe: t.anrede === r.anrede ? 1 : (t.anrede === 'keine' || r.anrede === 'keine' ? 0.5 : 0) };
  if (tv.length >= 10 && refVocab.size) {
    // Ein fremder Text trifft das Referenzvokabular zu etwa 40 Prozent; ab 75 Prozent gilt die Nähe als voll.
    const anteil = tv.filter(w => refVocab.has(w)).length / tv.length;
    f.wortschatz = { wert: Math.round(anteil * 100), referenz: 100, naehe: Math.max(0, Math.min(1, (anteil - 0.4) / 0.35)) };
  }
  if (r.wendungen.length) {
    const low = String(text).toLowerCase().replace(/[^a-zäöüéèàß0-9]+/g, ' ');
    const treffer = r.wendungen.filter(p => low.includes(p)).length;
    // Ein einzelner Text enthält nur wenige Wendungen; drei Treffer (oder alle, wenn es weniger gibt) gelten als voll.
    f.wendungen = { wert: treffer, referenz: r.wendungen.length, naehe: Math.min(1, treffer / Math.min(3, r.wendungen.length)) };
  }
  if (t.absatz && r.absatz) f.absatz = { wert: t.absatz, referenz: r.absatz, naehe: naehe(t.absatz, r.absatz, Math.max(TOL.absatzMin, TOL.absatzRel * r.absatz)) };

  // Fehlende Merkmale werden herausgerechnet (Gewichte neu auf 1 verteilt)
  let sum = 0, gew = 0;
  for (const k of Object.keys(f)) { sum += GEWICHTE[k] * f[k].naehe; gew += GEWICHTE[k]; f[k].gewicht = GEWICHTE[k]; f[k].naehe = Math.round(f[k].naehe * 100) / 100; }
  if (!gew) return null;
  return { wert: Math.round(100 * sum / gew), merkmale: f };
}

// ── Referenzmaterial und Speicherung ──────────────────────────────────────────────────────────────
let ensured = null;
function ensureTable() {
  if (!ensured) ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS stimmnaehe (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      analysis_id INTEGER,
      review_id INTEGER,
      art TEXT NOT NULL DEFAULT 'erzeugt',
      wert INTEGER NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// Referenzmaterial des Klienten: Quellmaterial und Referenztexte der Textarten, gesendete Goldtexte, sonst die Brand Voice
async function referenzTexte(clientId) {
  const { rows } = await pool.query(
    `SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND (memory_type='ref_brand_voice_source' OR memory_type LIKE 'ref_tg_%' OR memory_type='brand_voice')`, [clientId]);
  const refs = rows.filter(r => r.memory_type !== 'brand_voice').map(r => r.content);
  let gold = [];
  try { gold = (await pool.query('SELECT text FROM goldtexte WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10', [clientId])).rows.map(r => r.text); } catch { /* Tabelle fehlt: kein Goldtext */ }
  let list = refs.concat(gold);
  if (list.join('').length < MIN_REF_ZEICHEN) list = list.concat(rows.filter(r => r.memory_type === 'brand_voice').map(r => r.content));
  let left = MAX_REF_ZEICHEN;
  return list.filter(Boolean).map(t => { const c = String(t).slice(0, Math.max(0, left)); left -= c.length; return c; }).filter(Boolean);
}

async function speichern(clientId, key, art, res) {
  await ensureTable();
  const col = art === 'gesendet' ? 'review_id' : 'analysis_id';
  const { rows } = await pool.query(`SELECT id FROM stimmnaehe WHERE ${col}=$1 AND art=$2`, [key, art]);
  const details = JSON.stringify(res.merkmale);
  if (rows[0]) { await pool.query('UPDATE stimmnaehe SET wert=$2, details=$3, created_at=NOW() WHERE id=$1', [rows[0].id, res.wert, details]); return rows[0].id; }
  const ins = await pool.query(`INSERT INTO stimmnaehe (client_id, ${col}, art, wert, details) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [clientId, key, art, res.wert, details]);
  return ins.rows[0].id;
}

// Für einen neu erzeugten Text (aus analyze.js). Wirft nie.
async function fuerAnalyse(analysisId, clientId, module, text) {
  try {
    if (!clientId || !TEXT_MODULES.includes(module)) return null;
    const res = stimmnaehe(text, await referenzTexte(clientId));
    if (!res) return null;
    await speichern(clientId, analysisId, 'erzeugt', res);
    return res.wert;
  } catch (e) { console.error('[stimmnaehe]', e.message); return null; }
}
// Für eine gesendete Freigabe (aus reviews.js). Wirft nie.
async function fuerFreigabe(review) {
  try {
    if (!review || !review.client_id || !review.edited_text) return null;
    const res = stimmnaehe(review.edited_text, await referenzTexte(review.client_id));
    if (!res) return null;
    await speichern(review.client_id, review.id, 'gesendet', res);
    return res.wert;
  } catch (e) { console.error('[stimmnaehe]', e.message); return null; }
}

async function zuAnalyse(analysisId) {
  await ensureTable();
  const { rows } = await pool.query(`SELECT wert, details, art FROM stimmnaehe WHERE analysis_id=$1 AND art='erzeugt'`, [analysisId]);
  return rows[0] || null;
}

// Durchschnitt je Monat (letzte n Monate, ältester zuerst), getrennt nach erzeugt und gesendet
async function monatsDurchschnitt(clientId, n = 6, jetzt = new Date()) {
  await ensureTable();
  const key = d => d.getFullYear() * 12 + d.getMonth();
  const end = key(jetzt), start = end - (n - 1);
  const von = new Date(Math.floor(start / 12), start % 12, 1);
  const { rows } = await pool.query('SELECT art, wert, created_at FROM stimmnaehe WHERE client_id=$1 AND created_at >= $2', [clientId, von]);
  const out = [];
  for (let k = start; k <= end; k++) {
    const y = Math.floor(k / 12), m = k % 12;
    const o = { monat: `${y}-${String(m + 1).padStart(2, '0')}` };
    for (const art of ['erzeugt', 'gesendet']) {
      const v = rows.filter(r => r.art === art && key(new Date(r.created_at)) === k).map(r => r.wert);
      o[art] = { anzahl: v.length, schnitt: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null };
    }
    out.push(o);
  }
  return out;
}

module.exports = { GEWICHTE, kennzahlen, stimmnaehe, referenzTexte, fuerAnalyse, fuerFreigabe, zuAnalyse, monatsDurchschnitt, ensureTable };
