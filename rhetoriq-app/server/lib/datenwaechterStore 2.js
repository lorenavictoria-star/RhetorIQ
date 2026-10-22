// Daten-Wächter: Einstellungen (eine Zeile, für die ganze Plattform) und Protokoll ohne Inhalt.
// Das Protokoll enthält nur Zeit, Klient, Modus, Typ und Anzahl. Fundwerte werden nie gespeichert.
const { pool } = require('../db');
const dw = require('./datenwaechter');

const MODI = ['aus', 'warnen', 'ersetzen', 'sperren'];
const STANDARD = { modus: 'warnen', typen: dw.STANDARD_TYPEN.slice() };

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS datenwaechter_einstellungen (
      id INTEGER PRIMARY KEY,
      modus TEXT NOT NULL DEFAULT 'warnen',
      typen JSONB NOT NULL DEFAULT '[]',
      aktualisiert TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS datenwaechter_log (
      id SERIAL PRIMARY KEY,
      zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_id INTEGER,
      modus TEXT NOT NULL,
      typ TEXT NOT NULL,
      anzahl INTEGER NOT NULL DEFAULT 1
    )`);
  })().catch((e) => { ensured = null; throw e; });
  return ensured;
}

function bereinige(e) {
  const modus = MODI.includes(e && e.modus) ? e.modus : STANDARD.modus;
  const typen = Array.isArray(e && e.typen) ? e.typen.filter(t => dw.ALLE_TYPEN.includes(t)) : STANDARD.typen.slice();
  return { modus, typen: [...new Set(typen)] };
}

let cache = { at: 0, wert: null };
function cacheLeeren() { cache = { at: 0, wert: null }; }

// Liest die Einstellung (10 Sekunden zwischengespeichert). Bei einem Datenbankfehler gilt die Vorgabe.
async function holeEinstellungen() {
  if (cache.wert && Date.now() - cache.at < 10_000) return cache.wert;
  let wert;
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT modus, typen FROM datenwaechter_einstellungen WHERE id=1');
    wert = rows[0] ? bereinige(rows[0]) : { modus: STANDARD.modus, typen: STANDARD.typen.slice() };
  } catch {
    wert = { modus: STANDARD.modus, typen: STANDARD.typen.slice() };
  }
  cache = { at: Date.now(), wert };
  return wert;
}

async function speichereEinstellungen({ modus, typen }) {
  if (!MODI.includes(modus)) { const e = new Error('Ungültiger Modus.'); e.status = 400; throw e; }
  if (!Array.isArray(typen) || typen.some(t => !dw.ALLE_TYPEN.includes(t))) { const e = new Error('Ungültige Typen.'); e.status = 400; throw e; }
  const t = JSON.stringify([...new Set(typen)]);
  await ensureSchema();
  const up = await pool.query('UPDATE datenwaechter_einstellungen SET modus=$1, typen=$2, aktualisiert=NOW() WHERE id=1', [modus, t]);
  if (!up.rowCount) await pool.query('INSERT INTO datenwaechter_einstellungen (id, modus, typen) VALUES (1,$1,$2)', [modus, t]);
  cacheLeeren();
  return bereinige({ modus, typen });
}

// Protokoll ohne Inhalt: je Typ eine Zeile mit Anzahl
async function protokolliere({ clientId, modus, funde }) {
  try {
    if (!funde || !funde.length) return;
    await ensureSchema();
    for (const g of dw.gruppiere(funde)) {
      await pool.query('INSERT INTO datenwaechter_log (client_id, modus, typ, anzahl) VALUES ($1,$2,$3,$4)', [clientId || null, String(modus), g.typ, g.anzahl]);
    }
  } catch (e) { console.error('[datenwaechter] Protokoll fehlgeschlagen:', e && e.code ? e.code : 'Fehler'); }
}

async function auswertung(tage = 30) {
  await ensureSchema();
  const seit = new Date(Date.now() - tage * 86400000).toISOString();
  const { rows } = await pool.query('SELECT typ, anzahl, modus FROM datenwaechter_log WHERE zeit >= $1', [seit]);
  const nachTyp = new Map(), nachModus = new Map();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.anzahl) || 0;
    nachTyp.set(r.typ, (nachTyp.get(r.typ) || 0) + n);
    nachModus.set(r.modus, (nachModus.get(r.modus) || 0) + n);
    total += n;
  }
  return {
    tage, total,
    nachTyp: [...nachTyp].map(([typ, anzahl]) => ({ typ, label: dw.TYPEN[typ] ? dw.TYPEN[typ].label : typ, anzahl })).sort((a, b) => b.anzahl - a.anzahl),
    nachModus: [...nachModus].map(([modus, anzahl]) => ({ modus, anzahl }))
  };
}

async function loescheAlt() {
  await ensureSchema();
  const r = await pool.query(`DELETE FROM datenwaechter_log WHERE zeit < NOW() - INTERVAL '90 days'`);
  return r.rowCount || 0;
}

module.exports = { MODI, STANDARD, ensureSchema, holeEinstellungen, speichereEinstellungen, protokolliere, auswertung, loescheAlt, cacheLeeren };
