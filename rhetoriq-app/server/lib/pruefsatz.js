// Prüfsatz mit Blindvergleich (Stufe 3 aus «Messen statt hoffen»): Aus den letzten echten Aufträgen eines Klienten
// entstehen bis zu 10 Briefings. Jedes wird in mehreren Varianten erzeugt und der Beraterin anonym gemischt vorgelegt.
// Sie wählt je Auftrag, welcher Text mehr nach dem Klienten klingt. Am Ende zeigt die Auswertung, welche Variante wie oft gewann.
//
// Erzeugt wird über dieselbe Route wie bei echten Aufträgen (POST / in routes/analyze.js), intern aufgerufen mit
// req.pruefsatz = true. In diesem Modus entsteht kein Eintrag in analyses, es wird kein Kontingent verbraucht und kein
// Lernbeispiel gespeichert. Das Kostenprotokoll schreibt der Zähler (lib/meter.js) automatisch mit Modul «pruefsatz».
const crypto = require('crypto');
const { pool } = require('../db');
const { costUsd } = require('./meter');
const { resolveModelId } = require('./aiProvider');

// Varianten. Weitere (zum Beispiel C «ohne gelernte Vorlieben») lassen sich hier ergänzen: body wird in die Anfrage
// gemischt, durchgaenge sagt, wie viele KI-Aufrufe die Variante ungefähr braucht (für die Kostenschätzung).
const VARIANTEN = [
  { key: 'A', name: 'Standard', body: {}, durchgaenge: 2 },
  { key: 'B', name: 'ohne zweiten Durchgang', body: { thorough: false }, durchgaenge: 1 }
];

const MAX_BRIEFINGS = 10;
const MAX_BRIEFING_ZEICHEN = 4000;   // grössere Eingaben überspringen den zweiten Durchgang ohnehin (hasLargeInput)
const MIN_BRIEFING_ZEICHEN = 20;
const KOSTENGRENZE_USD = 3;          // harte Obergrenze je Lauf
// Typische Länge für die Schätzung, grosszügig gerechnet: Regelwerk, Brand Voice, Gedächtnis und Auftrag; Text von etwa 1000 Wörtern
const TYP_EINGABE_TOKENS = 15000;
const TYP_AUSGABE_TOKENS = 1500;
const USD_ZU_CHF = 0.9;              // Annahme für die Anzeige, kein Tageskurs

const MODULE = 'text-gen';

let ensured = null;
function ensureTable() {
  if (!ensured) ensured = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS pruefsatz_laeufe (
      id SERIAL PRIMARY KEY,
      client_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'laeuft',
      ergebnis JSONB
    )`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// Briefings aus den letzten echten Aufträgen des Klienten (ohne KI-Aufruf)
async function briefings(clientId, max = MAX_BRIEFINGS) {
  const { rows } = await pool.query(
    `SELECT id, input_data, feedback_key FROM analyses WHERE client_id=$1 AND module=$2 AND input_data IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 60`,
    [clientId, MODULE]);
  const seen = new Set(), out = [];
  for (const r of rows) {
    const data = typeof r.input_data === 'string' ? JSON.parse(r.input_data) : r.input_data;
    if (!data || typeof data !== 'object') continue;
    const len = String(data.text || '').length;
    if (len < MIN_BRIEFING_ZEICHEN) continue;
    if (len + String(data.existingDraft || '').length > MAX_BRIEFING_ZEICHEN) continue;
    const key = String(data.text).trim().toLowerCase().slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ quelle: r.id, module: MODULE, instructionsKey: r.feedback_key || MODULE, data });
    if (out.length >= max) break;
  }
  return out;
}

// Geschätzte Obergrenze in US-Dollar und Franken (eine Schätzung, kein fester Preis)
function schaetzung(anzahl, varianten = VARIANTEN) {
  const proAufruf = costUsd({ model: resolveModelId('sonnet'), inputTokens: TYP_EINGABE_TOKENS, outputTokens: TYP_AUSGABE_TOKENS });
  const aufrufe = anzahl * varianten.reduce((s, v) => s + v.durchgaenge, 0);
  const usd = Math.min(KOSTENGRENZE_USD, Math.round(aufrufe * proAufruf * 1000) / 1000);
  return { aufrufe, usd, chf: Math.round(usd * USD_ZU_CHF * 100) / 100, grenzeUsd: KOSTENGRENZE_USD, kursChf: USD_ZU_CHF };
}

async function vorschau(clientId) {
  const b = await briefings(clientId);
  return { anzahl: b.length, varianten: VARIANTEN.map(v => ({ key: v.key, name: v.name })), schaetzung: schaetzung(b.length), briefings: b.map(x => String(x.data.text).slice(0, 140)) };
}

// ── Erzeugung über die Route der echten Aufträge ───────────────────────────────────────────────
function erzeuge(authorization, advisorId, clientId, briefing, variante) {
  const analyze = require('../routes/analyze');
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST', url: '/', originalUrl: '/api/analyze', baseUrl: '/api/analyze', path: '/', headers: { authorization }, query: {}, params: {},
      body: { module: briefing.module, clientId, data: JSON.parse(JSON.stringify(briefing.data)), instructionsKey: briefing.instructionsKey, ...variante.body },
      app: { locals: {} }, pruefsatz: true, meterModule: 'pruefsatz'
    };
    let code = 200;
    const res = {
      headersSent: false,
      status(c) { code = c; return this; },
      set() { return this; }, setHeader() { return this; },
      json(o) { this.headersSent = true; if (code >= 400 || !o || typeof o.result !== 'string') reject(new Error((o && o.error) || 'Erzeugung fehlgeschlagen')); else resolve(o.result); }
    };
    analyze(req, res, err => reject(err || new Error('Route nicht erreicht')));
  });
}

// Bisher angefallene Kosten dieses Laufs aus dem Kostenprotokoll (Modul «pruefsatz»)
async function ausgegeben(clientId, seit) {
  const { rows } = await pool.query(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_log WHERE module='pruefsatz' AND client_id=$1 AND created_at >= $2`, [clientId, seit]);
  return Number(rows[0].s) || 0;
}

async function speichere(id, status, ergebnis) {
  await pool.query('UPDATE pruefsatz_laeufe SET status=$2, ergebnis=$3 WHERE id=$1', [id, status, JSON.stringify(ergebnis)]);
}

// Mischt die Texte eines Auftrags in zufällige Reihenfolge. reihenfolge[i] ist der Schlüssel der Variante, die an Position i steht.
function mische(keys, randomInt = crypto.randomInt) {
  const a = keys.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Startet einen Lauf. Legt die Zeile an und gibt sofort die Nummer zurück, die Erzeugung läuft im Hintergrund.
async function starten({ clientId, advisorId, authorization, varianten = VARIANTEN, wartenAufEnde = false }) {
  await ensureTable();
  const laufend = await pool.query(`SELECT id FROM pruefsatz_laeufe WHERE client_id=$1 AND status='laeuft'`, [clientId]);
  if (laufend.rows[0]) throw Object.assign(new Error('Für diesen Klienten läuft bereits ein Prüfsatz.'), { status: 409 });
  const b = await briefings(clientId);
  if (!b.length) throw Object.assign(new Error('Für diesen Klienten gibt es noch keine Aufträge im Text Generator, aus denen ein Prüfsatz entstehen könnte.'), { status: 400 });
  const seit = new Date(Date.now() - 1000);
  const erg = { varianten: varianten.map(v => ({ key: v.key, name: v.name })), schaetzung: schaetzung(b.length, varianten), gesamt: b.length, fertig: 0, kostenUsd: 0, grenzeUsd: KOSTENGRENZE_USD, auftraege: [], fehler: [] };
  const { rows } = await pool.query(`INSERT INTO pruefsatz_laeufe (client_id, status, ergebnis) VALUES ($1,'laeuft',$2) RETURNING id`, [clientId, JSON.stringify(erg)]);
  const id = rows[0].id;
  const job = (async () => {
    let status = 'bewertung';
    try {
      for (let i = 0; i < b.length; i++) {
        const spent = await ausgegeben(clientId, seit);
        erg.kostenUsd = Math.round(spent * 10000) / 10000;
        const schnitt = erg.fertig ? spent / erg.fertig : 0;
        if (spent >= KOSTENGRENZE_USD || spent + schnitt > KOSTENGRENZE_USD) { status = 'abgebrochen'; erg.abbruchGrund = `Die Kostenobergrenze von ${KOSTENGRENZE_USD} US-Dollar wäre überschritten worden.`; break; }
        const texte = await Promise.allSettled(varianten.map(v => erzeuge(authorization, advisorId, clientId, b[i], v)));
        if (texte.some(t => t.status === 'rejected')) {
          erg.fehler.push({ auftrag: i + 1, grund: String((texte.find(t => t.status === 'rejected').reason || {}).message || 'Fehler').slice(0, 200) });
        } else {
          const nach = {}; varianten.forEach((v, k) => { nach[v.key] = texte[k].value; });
          erg.auftraege.push({ nr: i + 1, briefing: String(b[i].data.text).slice(0, 300), reihenfolge: mische(varianten.map(v => v.key)), texte: nach, wahl: null });
        }
        erg.fertig = i + 1;
        await speichere(id, 'laeuft', erg);
      }
      if (status === 'bewertung' && !erg.auftraege.length) status = 'fehler';
      erg.kostenUsd = Math.round((await ausgegeben(clientId, seit)) * 10000) / 10000;
      await speichere(id, status === 'bewertung' ? 'bewertung' : status, erg);
    } catch (e) {
      console.error('[pruefsatz]', e.message);
      erg.fehlerText = String(e.message).slice(0, 200);
      await speichere(id, 'fehler', erg).catch(() => {});
    }
  })();
  if (wartenAufEnde) await job;
  return id;
}

// Ansicht für die Seite. Solange nicht fertig bewertet wurde, bleibt verborgen, welche Variante hinter welchem Text steckt.
function ansicht(row) {
  const e = row.ergebnis || {};
  const offen = (e.auftraege || []).filter(a => a.wahl == null).length;
  const fertigBewertet = row.status !== 'laeuft' && (e.auftraege || []).length > 0 && offen === 0;
  const out = {
    id: row.id, clientId: row.client_id, status: fertigBewertet ? 'ausgewertet' : row.status, erstellt: row.created_at,
    fortschritt: { fertig: e.fertig || 0, gesamt: e.gesamt || 0 }, kostenUsd: e.kostenUsd || 0, grenzeUsd: e.grenzeUsd, schaetzung: e.schaetzung,
    abbruchGrund: e.abbruchGrund || null, fehler: e.fehler || [], fehlerText: e.fehlerText || null,
    auftraege: row.status === 'laeuft' ? [] : (e.auftraege || []).map(a => ({
      nr: a.nr, briefing: a.briefing, wahl: a.wahl,
      texte: a.reihenfolge.map(k => a.texte[k])   // Reihenfolge ist gemischt, Schlüssel bleiben auf dem Server
    }))
  };
  if (fertigBewertet) out.auswertung = auswertung(e);
  return out;
}

function auswertung(e) {
  const sieger = {}; (e.varianten || []).forEach(v => { sieger[v.key] = { key: v.key, name: v.name, siege: 0 }; });
  let gleich = 0, bewertet = 0;
  for (const a of e.auftraege || []) {
    if (a.wahl == null) continue;
    bewertet++;
    if (a.wahl === 'gleich') { gleich++; continue; }
    const k = a.reihenfolge[a.wahl];
    if (sieger[k]) sieger[k].siege++;
  }
  const liste = Object.values(sieger);
  return { bewertet, gleich, varianten: liste, satz: satzVon(liste, gleich, bewertet) };
}

function satzVon(liste, gleich, bewertet) {
  if (!bewertet) return 'Noch nichts bewertet.';
  const teile = liste.map(v => `${v.name} ${v.siege} von ${bewertet}`);
  return `${teile.join(', ')}${gleich ? `, gleich ${gleich}` : ''}. Bei so wenigen Aufträgen zeigt das eine Tendenz.`;
}

async function laden(id) {
  await ensureTable();
  const { rows } = await pool.query('SELECT * FROM pruefsatz_laeufe WHERE id=$1', [id]);
  return rows[0] || null;
}

// Wahl der Beraterin: index = Position des gewählten Textes (0-basiert) oder 'gleich'
async function waehlen(id, nr, wahl) {
  const row = await laden(id);
  if (!row) throw Object.assign(new Error('Nicht gefunden.'), { status: 404 });
  const e = row.ergebnis;
  const a = (e.auftraege || []).find(x => x.nr === Number(nr));
  if (!a) throw Object.assign(new Error('Auftrag nicht gefunden.'), { status: 404 });
  if (wahl !== 'gleich') {
    const w = Number(wahl);
    if (!Number.isInteger(w) || w < 0 || w >= a.reihenfolge.length) throw Object.assign(new Error('Ungültige Wahl.'), { status: 400 });
    a.wahl = w;
  } else a.wahl = 'gleich';
  await pool.query('UPDATE pruefsatz_laeufe SET ergebnis=$2 WHERE id=$1', [id, JSON.stringify(e)]);
  return ansicht({ ...row, ergebnis: e });
}

async function liste(clientId) {
  await ensureTable();
  const { rows } = await pool.query('SELECT id, client_id, created_at, status, ergebnis FROM pruefsatz_laeufe WHERE client_id=$1 ORDER BY created_at DESC, id DESC LIMIT 10', [clientId]);
  return rows.map(r => { const a = ansicht(r); return { id: a.id, erstellt: a.erstellt, status: a.status, fortschritt: a.fortschritt, kostenUsd: a.kostenUsd, auswertung: a.auswertung || null }; });
}

module.exports = { VARIANTEN, KOSTENGRENZE_USD, briefings, schaetzung, vorschau, starten, ansicht, auswertung, waehlen, laden, liste, mische, ensureTable };
