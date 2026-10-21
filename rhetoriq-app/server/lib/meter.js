// Zentrale Zählung aller KI-Aufrufe: Tokens (inklusive Zwischenspeicher), Modell und exakte Kosten in US-Dollar.
// Jeder Aufruf über aiProvider wird hier automatisch erfasst. Die Zuordnung zu Beraterin und Klient kommt aus dem
// angemeldeten Zugriff (AsyncLocalStorage), kann aber pro Aufruf mit opts.meter überschrieben werden.
const { AsyncLocalStorage } = require('node:async_hooks');
const { pool } = require('../db');

// Preise in US-Dollar je 1 Million Tokens (Stand Anthropic-Preisliste für Sonnet 4.6 und Haiku 4.5).
// Zwischenspeicher schreiben kostet das 1.25-fache des Eingabepreises, Lesen das 0.1-fache.
const PRICES = {
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  // Generation 5 (Stand Preisliste Oktober 2026): Sonnet 5 und 5.5 je 2 und 10 Dollar, Zwischenspeicher lesen bei 5.5 nur 0.10;
  // Haiku 5.5 bis 100'000 Tokens Eingabe 0.10 und 0.50 (darüber teurer, hier nicht gerechnet, die Plattform sendet weit weniger)
  sonnet55: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.10 },
  haiku55: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 }
};
// Unbekannte Modelle werden vorsichtig wie Sonnet gerechnet, damit Kosten nie unterschätzt werden.
function tierOf(model) {
  const m = String(model || '');
  if (/haiku-5-5/i.test(m)) return 'haiku55';
  if (/haiku/i.test(m)) return 'haiku';
  if (/sonnet-5-5/i.test(m)) return 'sonnet55';
  return 'sonnet';
}

function costUsd({ model, inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0 }) {
  const p = PRICES[tierOf(model)];
  const c = (Number(inputTokens) * p.input + Number(outputTokens) * p.output
    + Number(cacheCreationTokens) * p.cacheWrite + Number(cacheReadTokens) * p.cacheRead) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

const als = new AsyncLocalStorage();
function run(store, fn) { return als.run(store, fn); }
function context() { return als.getStore() || {}; }

// Schreibt eine Zeile ins Nutzungsprotokoll. Wirft nie, damit ein Protokollfehler keinen Text verhindert.
async function record(entry) {
  try {
    const ctx = context();
    const o = entry.meter || {};
    const advisorId = o.advisorId !== undefined ? o.advisorId : ctx.advisorId;
    const clientId = o.clientId !== undefined ? o.clientId : ctx.clientId;
    const module = o.module || ctx.module || 'ki';
    const u = {
      model: entry.model, inputTokens: entry.inputTokens || 0, outputTokens: entry.outputTokens || 0,
      cacheCreationTokens: entry.cacheCreationTokens || 0, cacheReadTokens: entry.cacheReadTokens || 0
    };
    if (!(u.inputTokens || u.outputTokens || u.cacheCreationTokens || u.cacheReadTokens)) return null;
    const cost = costUsd(u);
    await pool.query(
      `INSERT INTO usage_log (advisor_id, client_id, module, input_tokens, output_tokens, model, cache_creation_tokens, cache_read_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [advisorId || null, clientId || null, String(module).slice(0, 80), u.inputTokens, u.outputTokens, u.model || null, u.cacheCreationTokens, u.cacheReadTokens, cost]);
    if (clientId) require('./costAlerts').check(clientId, advisorId).catch(() => {});
    if (clientId) require('./abo').pruefeSchwellen(clientId).catch(() => {});
    return cost;
  } catch (e) {
    console.error('[meter] Protokoll fehlgeschlagen:', e.message);
    return null;
  }
}

// Für Aufrufe, die die API direkt ansprechen: übernimmt das usage-Objekt der Antwort.
function recordApi(model, usage, meter) {
  const u = usage || {};
  return record({
    model, meter,
    inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0, cacheReadTokens: u.cache_read_input_tokens || 0
  });
}

// Zuordnung eines Zugriffs aus dem Anmelde-Token
function contextFromRequest(req, user) {
  const body = req.body || {}, q = req.query || {}, params = req.params || {};
  const advisorId = user.role === 'advisor' ? user.id : user.advisorId;
  const clientId = user.role === 'client' ? user.clientId : (body.clientId || q.clientId || q.client_id || params.clientId || null);
  const num = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
  // Kopfzeile des Daten-Wächters: verschärft einen einzelnen Aufruf von «warnen» auf «ersetzen» (Wahl «Ersetzen und senden»)
  const dwErsetzen = !!(req.headers && req.headers['x-daten-waechter'] === 'ersetzen');
  return { advisorId: num(advisorId), clientId: num(clientId), module: req.meterModule || body.module || null, ...(dwErsetzen ? { dwErsetzen: true } : {}) };
}

// COALESCE-Ausdruck für ältere Zeilen ohne exakte Kosten (reiner Sonnet-Preis auf die erfassten Tokens)
const COST_SQL = `COALESCE(cost_usd, (input_tokens * 3.0 + output_tokens * 15.0) / 1000000.0)`;

module.exports = { PRICES, costUsd, record, recordApi, run, context, contextFromRequest, COST_SQL };
