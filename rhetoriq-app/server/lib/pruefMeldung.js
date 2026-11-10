// Meldungen an die Beraterin zu Texten, die zur Prüfung warten (Mischform):
//  - Fristen unter einer Stunde melden sich sofort (routes/reviews.js, POST).
//  - Alle anderen Texte stehen sofort in der Prüfliste, die Mail dazu kommt gebündelt: höchstens eine Sammelmail pro Zeitfenster
//    von 90 Minuten, nur zwischen 07:00 und 20:00 (Zürcher Zeit), nur wenn etwas Neues wartet.
//  - Eine Erinnerung kommt, wenn die Frist in weniger als 30 Minuten abläuft und der Text noch wartet.
// Läuft der Job auf zwei Instanzen gleichzeitig, schickt dank lib/einmalig.js nur eine die Mail.
const { pool } = require('../db');
const { queueEmail } = require('./emailOutbox');
const { ersterLauf } = require('./einmalig');
const { advisorEmails } = require('./notify');
const { ensureSchema } = require('./schemaRedesign');

const SOFORT_MS = 60 * 60 * 1000;     // Frist in höchstens einer Stunde: sofort melden
const ERINNERUNG_MS = 30 * 60 * 1000; // Erinnerung 30 Minuten vor Ablauf
const SLOT_MIN = 90;                  // Länge eines Meldefensters
const START_MIN = 7 * 60;             // erstes Fenster ab 07:00
const ENDE_MIN = 20 * 60;             // keine Meldungen ab 20:00

function sofortNoetig(dueAt, now = new Date()) {
  const t = dueAt ? new Date(dueAt).getTime() : NaN;
  return Number.isFinite(t) && t - now.getTime() <= SOFORT_MS;
}

// Zürcher Datum (JJJJ-MM-TT) und Minuten seit Mitternacht
function zuerich(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = t => p.find(x => x.type === t).value;
  return { datum: `${g('year')}-${g('month')}-${g('day')}`, minuten: Number(g('hour')) * 60 + Number(g('minute')) };
}

// Schlüssel des laufenden 90-Minuten-Fensters, null ausserhalb der Meldezeit
function slotKey(now = new Date()) {
  const z = zuerich(now);
  if (z.minuten < START_MIN || z.minuten >= ENDE_MIN) return null;
  return `${z.datum}-${Math.floor((z.minuten - START_MIN) / SLOT_MIN)}`;
}

const uhr = d => new Date(d).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
const kurz = (t, n = 140) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function zeile(r, i) {
  const frist = r.due_at ? `bis ${uhr(r.due_at)}` : 'ohne Frist';
  const auftrag = r.instruction || r.client_note;
  return `${i + 1}. ${r.client_name || 'Unbekannt'} · ${r.module_label || 'Text'} · ${frist}${auftrag ? `\n   Auftrag: ${kurz(auftrag)}` : ''}`;
}

async function wartende(db, bedingung, params = []) {
  const { rows } = await db.query(
    `SELECT r.id, r.module_label, r.instruction, r.client_note, r.due_at, r.created_at, c.name AS client_name
     FROM review_requests r LEFT JOIN clients c ON c.id = r.client_id
     WHERE r.status = 'pending' AND ${bedingung} ORDER BY r.due_at ASC NULLS LAST, r.created_at ASC`, params);
  return rows;
}

// Nummern aus der Datenbank, nur ganze Zahlen (kein Platzhalter-Array, damit es auch im Test läuft)
const idListe = rows => rows.map(r => Number(r.id)).filter(Number.isInteger).join(',') || '0';

async function senden(betreff, text) {
  for (const to of advisorEmails()) await queueEmail({ kind: 'review-sammel', to, subject: betreff, text, senderName: 'RhetorIQ' });
}

// Sammelmail: alle wartenden Texte, über die noch keine Mail ging. Gibt die Anzahl zurück.
async function sammelmeldung(now = new Date(), db = pool) {
  await ensureSchema().catch(() => {});
  const key = slotKey(now);
  if (!key) return 0;
  const neu = await wartende(db, 'r.notified_at IS NULL');
  if (!neu.length) return 0;
  if (!(await ersterLauf('pruef-sammel-' + key, db))) return 0;
  const alle = await wartende(db, '1=1');
  const text = `In der Prüfliste warten ${alle.length} ${alle.length === 1 ? 'Text' : 'Texte'}, davon ${neu.length} neu:\n\n${alle.map(zeile).join('\n\n')}\n\nÖffne die Prüfliste in RhetorIQ: https://rhetoriq.ch\n\nDie nächste Sammelmail kommt frühestens in 90 Minuten. Bei Fristen unter einer Stunde melde ich mich sofort.`;
  await senden(`RhetorIQ: ${alle.length} ${alle.length === 1 ? 'Text wartet' : 'Texte warten'} auf Prüfung`, text);
  await db.query(`UPDATE review_requests SET notified_at = NOW() WHERE id IN (${idListe(neu)})`);
  return neu.length;
}

// Erinnerung kurz vor Ablauf der Frist (einmal je Text)
async function erinnerungen(now = new Date(), db = pool) {
  await ensureSchema().catch(() => {});
  if (!slotKey(now)) return 0;
  const bis = new Date(now.getTime() + ERINNERUNG_MS);
  const rows = await wartende(db, 'r.reminded_at IS NULL AND r.due_at IS NOT NULL AND r.due_at <= $1', [bis]);
  if (!rows.length) return 0;
  const text = `Die Frist läuft bald ab oder ist schon vorbei:\n\n${rows.map(zeile).join('\n\n')}\n\nÖffne die Prüfliste in RhetorIQ: https://rhetoriq.ch`;
  await senden(`RhetorIQ: Frist läuft ab (${rows.length})`, text);
  await db.query(`UPDATE review_requests SET reminded_at = NOW(), notified_at = COALESCE(notified_at, NOW()) WHERE id IN (${idListe(rows)})`);
  return rows.length;
}

async function runPruefMeldung(now = new Date()) {
  try {
    const erinnert = await erinnerungen(now);
    const gesammelt = await sammelmeldung(now);
    return { erinnert, gesammelt };
  } catch (e) { console.error('[pruef-meldung]', e.message); return { erinnert: 0, gesammelt: 0 }; }
}

module.exports = { sofortNoetig, slotKey, sammelmeldung, erinnerungen, runPruefMeldung, SOFORT_MS, SLOT_MIN };
