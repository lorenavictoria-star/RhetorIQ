// Vergleich Entwurf und Endtext (Stufe 4 aus «Messen statt hoffen»): Bringt der zweite Durchgang etwas?
// Beim Erzeugen mit zweitem Durchgang werden Entwurf und Endtext abgelegt und lokal verglichen (ohne KI):
// Änderungsanteil in Sätzen, Stimmnähe vorher und nachher, Lint-Treffer vorher und nachher (falls lib/lint.js existiert).
// Der zweite Durchgang bleibt Standard. Hier wird nur gemessen.
const { pool } = require('../db');
const { anteilUnveraenderterSaetze } = require('./lernkurve');
const sn = require('./stimmnaehe');

const WESENTLICH = 0.2;   // ab diesem Änderungsanteil (Sätze des Entwurfs, die sich ändern) gilt die Überarbeitung als wesentlich
const MIN_TEXTE = 20;     // darunter ist die Auswertung nur ein Zwischenstand
const STIMM_MODULES = ['text-gen', 'brief', 'ghostwriter', 'before-after'];

let ensured = null;
function ensureTable() {
  if (!ensured) ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS durchgang_vergleich (
      id SERIAL PRIMARY KEY,
      analysis_id INTEGER,
      client_id INTEGER,
      advisor_id INTEGER,
      module TEXT,
      entwurf TEXT,
      endtext TEXT,
      aenderungsanteil REAL,
      lint_treffer_vorher INTEGER,
      lint_treffer_nachher INTEGER,
      stimmnaehe_vorher INTEGER,
      stimmnaehe_nachher INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// Anzahl Lint-Treffer, falls es einen Lint gibt (lib/lint.js, Funktion lintText). Sonst null.
function lintCount(text) {
  let lint;
  try { lint = require('./lint'); } catch { return null; }
  if (!lint || typeof lint.lintText !== 'function') return null;
  try {
    const r = lint.lintText(text);
    if (Array.isArray(r)) return r.length;
    if (r && Array.isArray(r.treffer)) return r.treffer.length;
    if (r && Array.isArray(r.findings)) return r.findings.length;
    if (r && Array.isArray(r.hits)) return r.hits.length;
    return null;
  } catch { return null; }
}

// Misst einen Entwurf gegen den Endtext. refs: Referenztexte des Klienten (oder leer).
function vergleiche(entwurf, endtext, refs, module) {
  const unv = anteilUnveraenderterSaetze(entwurf, endtext);
  const out = { aenderungsanteil: unv == null ? null : Math.round((1 - unv) * 1000) / 1000, lintVorher: lintCount(entwurf), lintNachher: lintCount(endtext), stimmVorher: null, stimmNachher: null };
  if (STIMM_MODULES.includes(module) && refs && refs.length) {
    const v = sn.stimmnaehe(entwurf, refs), n = sn.stimmnaehe(endtext, refs);
    if (v && n) { out.stimmVorher = v.wert; out.stimmNachher = n.wert; }
  }
  return out;
}

// Speichert Entwurf und Endtext (aus analyze.js). Wirft nie.
async function speichern({ analysisId, clientId, advisorId, module, entwurf, endtext }) {
  try {
    if (!entwurf || !endtext) return null;
    await ensureTable();
    const refs = clientId && STIMM_MODULES.includes(module) ? await sn.referenzTexte(clientId) : [];
    const m = vergleiche(entwurf, endtext, refs, module);
    const { rows } = await pool.query(
      `INSERT INTO durchgang_vergleich (analysis_id, client_id, advisor_id, module, entwurf, endtext, aenderungsanteil, lint_treffer_vorher, lint_treffer_nachher, stimmnaehe_vorher, stimmnaehe_nachher)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [analysisId || null, clientId || null, advisorId || null, module || null, entwurf, endtext, m.aenderungsanteil, m.lintVorher, m.lintNachher, m.stimmVorher, m.stimmNachher]);
    return rows[0].id;
  } catch (e) { console.error('[durchgang]', e.message); return null; }
}

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

// Auswertung der letzten `days` Tage für eine Beraterin
async function auswertung(advisorId, days = 90) {
  await ensureTable();
  const d = Math.max(1, Math.min(730, Number(days) || 90));
  const von = new Date(Date.now() - d * 86400000);
  const { rows } = await pool.query(
    `SELECT aenderungsanteil, lint_treffer_vorher, lint_treffer_nachher, stimmnaehe_vorher, stimmnaehe_nachher FROM durchgang_vergleich
     WHERE advisor_id=$1 AND created_at >= $2`, [advisorId, von]);
  const mitAend = rows.filter(r => r.aenderungsanteil != null);
  const wesentlich = mitAend.filter(r => Number(r.aenderungsanteil) >= WESENTLICH).length;
  const stimm = rows.filter(r => r.stimmnaehe_vorher != null && r.stimmnaehe_nachher != null);
  const lint = rows.filter(r => r.lint_treffer_vorher != null && r.lint_treffer_nachher != null);
  const res = {
    tage: d,
    anzahl: rows.length,
    zwischenstand: rows.length < MIN_TEXTE,
    mindestTexte: MIN_TEXTE,
    wesentlichSchwelle: Math.round(WESENTLICH * 100),
    wesentlich: { anzahl: wesentlich, von: mitAend.length, prozent: mitAend.length ? Math.round(100 * wesentlich / mitAend.length) : null },
    aenderungSchnittProzent: mitAend.length ? Math.round(100 * avg(mitAend.map(r => Number(r.aenderungsanteil)))) : null,
    stimmnaehe: { anzahl: stimm.length, vorher: r1(avg(stimm.map(r => r.stimmnaehe_vorher))), nachher: r1(avg(stimm.map(r => r.stimmnaehe_nachher))), differenz: stimm.length ? r1(avg(stimm.map(r => r.stimmnaehe_nachher - r.stimmnaehe_vorher))) : null },
    lint: { anzahl: lint.length, vorher: r1(avg(lint.map(r => r.lint_treffer_vorher))), nachher: r1(avg(lint.map(r => r.lint_treffer_nachher))), verschwunden: lint.length ? r1(avg(lint.map(r => r.lint_treffer_vorher - r.lint_treffer_nachher))) : null }
  };
  res.satz = satz(res);
  return res;
}

function satz(a) {
  if (!a.anzahl) return 'Noch keine Texte mit zweitem Durchgang im gewählten Zeitraum.';
  const teile = [];
  if (a.wesentlich.von) teile.push(`In ${a.wesentlich.anzahl} von ${a.wesentlich.von} Texten (${a.wesentlich.prozent} Prozent) hat der zweite Durchgang den Entwurf wesentlich verändert.`);
  if (a.stimmnaehe.anzahl) {
    const dlt = a.stimmnaehe.differenz;
    teile.push(dlt > 0 ? `Die Stimmnähe stieg im Schnitt um ${dlt} Punkte.` : dlt < 0 ? `Die Stimmnähe sank im Schnitt um ${Math.abs(dlt)} Punkte.` : 'Die Stimmnähe blieb im Schnitt gleich.');
  }
  if (a.lint.anzahl) teile.push(`Pro Text verschwanden im Schnitt ${a.lint.verschwunden} Lint-Treffer.`);
  if (a.zwischenstand) teile.push(`Das ist ein Zwischenstand aus ${a.anzahl} Texten, aussagekräftig wird es ab ${a.mindestTexte}.`);
  return teile.join(' ');
}

module.exports = { WESENTLICH, vergleiche, speichern, auswertung, ensureTable, lintCount };
