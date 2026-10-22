// Serverseitige Durchsetzung der Modul- und Textart-Auswahl pro Klient.
// clients.enabled_modules (null = alle) und clients.enabled_textarten (null = alle Textarten).
// Die Beraterin, der Prüfsatz und die Ansicht des Klienten (viewAs) sind nie betroffen.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');

const TEXTARTEN = ['linkedin', 'newsletter', 'email', 'speech', 'press', 'website', 'brief', 'custom'];

const SPERR_MODUL = 'Dieses Modul ist für Ihr Konto nicht freigeschaltet. Bitte wenden Sie sich an Ihre Beraterin.';
const SPERR_TEXTART = 'Diese Textart ist für Ihr Konto nicht freigeschaltet. Bitte wenden Sie sich an Ihre Beraterin.';

// Anfrage-Modul der KI-Route -> Schlüssel in enabled_modules (eine Freischaltung genügt).
// Nicht aufgeführte Module (Brand Voice, Router, Hilfsfunktionen) sind immer erlaubt.
const API_ZU_SCHLUESSEL = {
  rp: ['profiling'],
  rm: ['risk'], 'competitive-check': ['risk'],
  as: ['actionability'], 'before-after': ['actionability', 'risk'],
  crisis: ['crisis'], 'crisis-toolkit': ['crisis'],
  tc: ['thread'],
  'rh-translate': ['rh-translate'],
  sparring: ['sparring'], debrief: ['debrief'],
  pr: ['review'], rw: ['recognition', 'review'],
  'text-gen': ['text-gen'], 'vs-gen': ['vs-gen', 'text-gen'], 'vs-cal': ['vs-cal', 'text-gen'],
  brief: ['brief', 'text-gen'],
  presentation: ['presentation'], 'customer-review': ['customer-review'],
  'pre-meeting': ['pre-meeting'], 'arg-reaction': ['arg-reaction'], st: ['arg-reaction'], si: ['arg-reaction'], la: ['arg-reaction'],
  'cm-qa-trainer': ['cm-qa-trainer'], 'cm-equity-story': ['cm-equity-story'], 'cm-earnings-analyzer': ['cm-earnings-analyzer'],
  'cm-board-coach': ['cm-board-coach'], 'cm-roadshow': ['cm-roadshow'],
  'ht-guest-letter': ['ht-guest-letter'], 'ht-review-response': ['ht-review-response'], 'ht-crisis-comm': ['ht-crisis-comm'],
  'ht-positioning': ['ht-positioning'], 'ht-sales-pitch': ['ht-sales-pitch']
};

async function lade(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT enabled_modules, enabled_textarten FROM clients WHERE id=$1', [clientId]);
  return rows[0] || null;
}

// Textart aus der Anfrage: instructionsKey 'text-gen-<kachel>'; ohne Angabe gilt wie im Frontend 'custom'
function textartAus(instructionsKey) {
  const m = /^text-gen-([a-z]+)$/.exec(String(instructionsKey || ''));
  return m ? m[1] : 'custom';
}

function modulErlaubt(mods, apiModul) {
  const schl = API_ZU_SCHLUESSEL[apiModul];
  if (!schl || mods == null) return true;
  return schl.some(k => mods.includes(k));
}
function textartErlaubt(arten, textart) { return arten == null || arten.includes(textart); }

// Prüft Modul und Textart für einen Klienten. Gibt { ok:true } oder { ok:false, error } zurück.
async function pruefe(clientId, apiModul, instructionsKey) {
  if (!clientId) return { ok: true };
  const c = await lade(clientId);
  if (!c) return { ok: true };
  if (!modulErlaubt(c.enabled_modules, apiModul)) return { ok: false, error: SPERR_MODUL };
  if (apiModul === 'text-gen' && !textartErlaubt(c.enabled_textarten, textartAus(instructionsKey))) return { ok: false, error: SPERR_TEXTART };
  return { ok: true };
}

async function textartFuerKlient(clientId, textart) {
  const c = await lade(clientId);
  return !c || textartErlaubt(c.enabled_textarten, textart);
}

// Express-Hilfe: nur Klienten-Konten werden geprüft (Beraterin, Prüfsatz und Ansicht bleiben unberührt).
// Rückgabe true = gesperrt und bereits mit 403 beantwortet.
async function sperrt(req, res, apiModul, instructionsKey) {
  if (req.pruefsatz === true || req.user?.role !== 'client') return false;
  const r = await pruefe(req.user.clientId, apiModul, instructionsKey);
  if (r.ok) return false;
  res.status(403).json({ error: r.error, modulGesperrt: true });
  return true;
}

module.exports = { TEXTARTEN, API_ZU_SCHLUESSEL, SPERR_MODUL, SPERR_TEXTART, pruefe, sperrt, textartAus, modulErlaubt, textartErlaubt, textartFuerKlient };
