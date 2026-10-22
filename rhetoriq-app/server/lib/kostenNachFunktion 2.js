// Kosten je Funktion (Spalte module im Nutzungsprotokoll): Aufrufe, Tokens, Kosten, Anteil, Hinweis «läuft ohne Klick».
// Genutzt von GET /api/advisor/costs-by-module und vom Wochenbericht. Die Kosten stammen aus usage_log.cost_usd
// (lib/meter.js, exakte Preise je Modell). Ältere Zeilen ohne Kosten werden nach Sonnet-Preis gerechnet (COST_SQL).
const { pool } = require('../db');
const { COST_SQL } = require('./meter');
const { info } = require('./kostenInventar');

// Namen aus dem Modulkatalog enthalten teils Gedankenstriche: in der Anzeige durch einen Doppelpunkt ersetzt
const ohneStrich = (t) => String(t).replace(/\s*[\u2013\u2014]\s*/g, ': ');
const tierOf = (model) => (/haiku/i.test(String(model || '')) ? 'Haiku' : (model ? 'Sonnet' : null));

// scope: { advisorId, clientIds: [..], plattform: bool }. Ohne scope zählt die ganze Plattform (Wochenbericht).
async function kostenNachFunktion({ days = 30, scope = null, labelFor = null } = {}) {
  const params = [days];
  let where = `created_at > NOW() - ($1 || ' days')::interval`;
  if (scope) {
    const teile = ['advisor_id = $2'];
    params.push(scope.advisorId);
    if (scope.clientIds && scope.clientIds.length) { params.push(scope.clientIds); teile.push(`(advisor_id IS NULL AND client_id = ANY($${params.length}::int[]))`); }
    if (scope.plattform) teile.push('(advisor_id IS NULL AND client_id IS NULL)');
    where += ` AND (${teile.join(' OR ')})`;
  }
  const { rows } = await pool.query(
    `SELECT module, model, COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens, COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::bigint AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(${COST_SQL}),0)::float AS cost_usd
     FROM usage_log WHERE ${where} GROUP BY module, model`, params);
  const by = new Map();
  for (const r of rows) {
    const key = r.module || 'ki';
    const e = by.get(key) || { module: key, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, models: new Set() };
    e.calls += r.calls;
    e.input_tokens += Number(r.input_tokens); e.output_tokens += Number(r.output_tokens);
    e.cache_read_tokens += Number(r.cache_read_tokens); e.cache_creation_tokens += Number(r.cache_creation_tokens);
    e.cost_usd += Number(r.cost_usd);
    const t = tierOf(String(r.model || '').replace(/^reserve:/, ''));
    if (t) e.models.add(t);
    by.set(key, e);
  }
  const total = [...by.values()].reduce((s, e) => s + e.cost_usd, 0);
  const list = [...by.values()].map(e => {
    const i = info(e.module);
    const cacheTotal = e.cache_read_tokens + e.cache_creation_tokens;
    return {
      module: e.module, label: ohneStrich(i.ausloeser === null ? ((labelFor && labelFor(e.module)) || i.label) : i.label), automatisch: i.automatisch, ausloeser: i.ausloeser,
      calls: e.calls, input_tokens: e.input_tokens, output_tokens: e.output_tokens,
      cache_read_tokens: e.cache_read_tokens, cache_creation_tokens: e.cache_creation_tokens,
      // Anteil der Zwischenspeicher-Tokens, die gelesen (günstig) statt geschrieben (Zuschlag) wurden
      cache_read_share: cacheTotal ? Math.round(e.cache_read_tokens / cacheTotal * 100) : null,
      models: [...e.models].sort(),
      cost_usd: Math.round(e.cost_usd * 1e6) / 1e6,
      cost_per_call: e.calls ? Math.round(e.cost_usd / e.calls * 1e6) / 1e6 : 0,
      share: total > 0 ? Math.round(e.cost_usd / total * 1000) / 10 : 0
    };
  }).sort((a, b) => b.cost_usd - a.cost_usd);
  const auto = list.filter(r => r.automatisch).reduce((s, r) => s + r.cost_usd, 0);
  return {
    days, total_usd: Math.round(total * 1e6) / 1e6, rows: list,
    auto_usd: Math.round(auto * 1e6) / 1e6, auto_share: total > 0 ? Math.round(auto / total * 1000) / 10 : 0,
    top3: list.slice(0, 3).map(r => ({ module: r.module, label: r.label, cost_usd: r.cost_usd, share: r.share, automatisch: r.automatisch }))
  };
}

// Eine Zeile für den Wochenbericht: die drei teuersten Funktionen
function zeileTeuersteFunktionen(d) {
  if (!d || !d.top3.length) return null;
  const teile = d.top3.map(t => `${t.label} USD ${t.cost_usd.toFixed(2)} (${String(t.share).replace('.', ',')} %)${t.automatisch ? ', läuft ohne Klick' : ''}`);
  return `  Teuerste Funktionen: ${teile.join('; ')}`;
}

module.exports = { kostenNachFunktion, zeileTeuersteFunktionen };
