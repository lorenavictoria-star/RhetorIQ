// Tagesbudgets für Hintergrundfunktionen der KI (US-Dollar je Funktion und Tag, plattformweit).
// Die Summen kommen aus dem Nutzungsprotokoll (usage_log, Spalte module). Ist die Grenze erreicht, wird die Funktion für den
// Rest des Tages übersprungen und Lorena einmal pro Funktion und Tag per Mail informiert.
// NICHT betroffen: alles, was eine Person für ihren Text anklickt (Text-Generator, Module, Nachfragen), dort gelten die
// Tagesgrenzen der Kostenbremse (lib/costBrake.js).
// Überschreiben ohne Code: Umgebungsvariable BUDGET_<NAME>_USD, zum Beispiel BUDGET_THEMENPLAN_USD=8 (0 oder ungültig: Standard).
// Der Tag beginnt um Mitternacht in Zürich (Sommerzeit-Wechsel: höchstens eine Stunde Abweichung am Umstellungstag).
const { pool } = require('../db');
const { COST_SQL } = require('./meter');

// name: Standardgrenze in US-Dollar je Tag; module: Schlüssel im Nutzungsprotokoll, die zusammen zählen
const FUNKTIONEN = {
  waechter: { usd: 0.10, label: 'KI-Wächter', module: ['waechter'] },
  messungen: { usd: 1.00, label: 'Kommunikationsprofil-Messungen', module: ['comm-profile'] },
  themenplan: { usd: 5.00, label: 'Themenplan und Newsletter-Entwurf', module: ['themenplan'] },
  quartalsreview: { usd: 1.00, label: 'Quartalsauswertung', module: ['quartalsreview'] },
  schnelltest: { usd: 2.00, label: 'Stimm-Schnelltest', module: ['schnelltest'] },
  lernvorschlaege: { usd: 2.00, label: 'Lernvorschläge', module: ['lernen-korrektur', 'lernen-nachfrage', 'lernen-daumen'] },
  'hilfe-chat': { usd: 2.00, label: 'Hilfe-Chat', module: ['hilfe-chat'] },
  'memory-vorschlag': { usd: 1.00, label: 'Dokumenttyp-Vorschläge im Gedächtnis', module: ['memory-vorschlag'] },
  feedback: { usd: 0.50, label: 'Lösungsvorschläge zu Feedback-Notizen', module: ['feedback-vorschlag'] }
};

function envName(name) { return 'BUDGET_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_USD'; }
function limitFor(name) {
  const f = FUNKTIONEN[name];
  if (!f) return null;
  const v = parseFloat(process.env[envName(name)]);
  return Number.isFinite(v) && v > 0 ? v : f.usd;
}

// Beginn des heutigen Tages in Zürich als Zeitpunkt
function tagesbeginn(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = t => Number(p.find(x => x.type === t).value);
  const y = g('year'), m = g('month'), d = g('day');
  const mittag = Date.UTC(y, m - 1, d, 12);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }).format(mittag));
  return { start: new Date(Date.UTC(y, m - 1, d) - (h - 12) * 3600 * 1000), tag: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

async function spentToday(name, now = new Date()) {
  const f = FUNKTIONEN[name];
  const { start } = tagesbeginn(now);
  const { rows } = await pool.query(`SELECT COALESCE(SUM(${COST_SQL}),0)::float AS c FROM usage_log WHERE module = ANY($1) AND created_at >= $2`, [f.module, start]);
  return rows[0].c;
}

async function mailOnce(name, spent, limit, tag) {
  try {
    const { getStatus, setStatus } = require('./systemStatus');
    const key = 'budget_mail:' + name;
    const last = await getStatus(key, null);
    if (last && last.tag === tag) return false;
    await setStatus(key, { tag });
    const f = FUNKTIONEN[name];
    await require('./notify').mailAdvisor(`RhetorIQ Tagesbudget: ${f.label} pausiert bis morgen`,
      `Hallo Lorena\n\nDie Funktion «${f.label}» hat heute $${spent.toFixed(2)} an KI-Kosten verursacht (Tagesgrenze: $${limit.toFixed(2)}). Sie wird bis morgen übersprungen. Texte, die jemand selbst erzeugt, sind davon nicht betroffen.\n\nWenn das erwartet war (zum Beispiel ein grosser Lauf), erhöhe die Grenze in Render mit ${envName(name)}. Wenn nicht, schau auf der Seite Nutzung unter «Wohin das KI-Geld fliesst» nach.\n\nDiese Mail kommt einmal pro Funktion und Tag.\n\nRhetorIQ`);
    return true;
  } catch (e) {
    console.error('[budget] Mail fehlgeschlagen:', e.message);
    return false;
  }
}

// Darf die Funktion jetzt noch KI aufrufen? Fehler beim Prüfen sperren nie (offen bei Störung).
async function allow(name, now = new Date()) {
  try {
    if (!FUNKTIONEN[name]) return { ok: true, unbekannt: true };
    const limit = limitFor(name);
    const spent = await spentToday(name, now);
    if (spent >= limit) {
      await mailOnce(name, spent, limit, tagesbeginn(now).tag);
      return { ok: false, spent, limit, name };
    }
    return { ok: true, spent, limit, name };
  } catch (e) {
    console.error('[budget] Prüfung fehlgeschlagen:', e.message);
    return { ok: true, fehler: true };
  }
}

module.exports = { allow, limitFor, spentToday, tagesbeginn, FUNKTIONEN, envName };
