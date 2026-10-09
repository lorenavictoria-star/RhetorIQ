// Zeiterfassung für persönliche Bearbeitung: inbegriffene Minuten je Paket, Mehraufwand zu CHF 180 pro Stunde im 15-Minuten-Takt.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { planPriceChf } = require('./costAlerts');

const RATE_CHF = parseFloat(process.env.HOURLY_RATE_CHF) || 180;
const STEP = 15;
// Inbegriffene Minuten je Monat: Überarbeitungen mal 15 Minuten (Starter 2, Wachstum 6, Team 15), Enterprise 5 Stunden
const PLAN_MINUTES = { starter: 30, wachstum: 90, team: 225, enterprise: 300 };
const DEFAULT_PLAN = 'wachstum';

function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.test(String(month || '')) ? String(month) : new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const from = new Date(Date.UTC(y, mo - 1, 1)), to = new Date(Date.UTC(y, mo, 1));
  return { month: m, from: from.toISOString(), to: to.toISOString() };
}

function extraFor(used, pool_) {
  const extra = Math.max(0, used - pool_);
  const billedMin = Math.ceil(extra / STEP) * STEP;
  return { extraMinutes: extra, billedMinutes: billedMin, extraChf: Math.round(billedMin / 60 * RATE_CHF * 100) / 100 };
}

async function clientSummary(clientId, month) {
  await ensureSchema();
  const r = monthRange(month);
  const { rows: c } = await pool.query('SELECT id, name, recommended_plan, included_minutes, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
  if (!c[0]) return null;
  const poolMin = c[0].included_minutes != null ? Number(c[0].included_minutes) : (PLAN_MINUTES[c[0].recommended_plan] ?? PLAN_MINUTES[DEFAULT_PLAN]);
  const { rows } = await pool.query(
    `SELECT id, module_label, minutes, time_logged_at FROM review_requests
     WHERE client_id=$1 AND minutes IS NOT NULL AND time_logged_at >= $2 AND time_logged_at < $3 ORDER BY time_logged_at ASC`,
    [clientId, r.from, r.to]);
  const used = rows.reduce((s, x) => s + Number(x.minutes || 0), 0);
  // Monatsabo laut gebuchtem Kontingent (wie in den Kostenwarnungen), der Mehraufwand kommt oben drauf
  const aboChf = planPriceChf(c[0].monthly_token_limit);
  const ex = extraFor(used, poolMin);
  return {
    month: r.month, aboChf, totalChf: aboChf != null ? Math.round((aboChf + ex.extraChf) * 100) / 100 : null, clientId: c[0].id, clientName: c[0].name, plan: c[0].recommended_plan || null,
    includedMinutes: poolMin, customIncluded: c[0].included_minutes != null, usedMinutes: used, rateChf: RATE_CHF, step: STEP,
    ...extraFor(used, poolMin), rows
  };
}

async function setMinutes(reviewId, minutes) {
  await ensureSchema();
  const m = minutes === null || minutes === '' ? null : Math.round(Number(minutes));
  if (m !== null && (!Number.isFinite(m) || m < 0 || m > 600)) throw new Error('Minuten müssen zwischen 0 und 600 liegen.');
  const { rows } = await pool.query(
    `UPDATE review_requests SET minutes=$1, time_logged_at=CASE WHEN $1 IS NULL THEN NULL ELSE COALESCE(time_logged_at, NOW()) END WHERE id=$2 RETURNING id, client_id, minutes, time_logged_at`,
    [m, reviewId]);
  return rows[0] || null;
}

async function exportCsv(advisorId, month) {
  await ensureSchema();
  const { rows: cl } = await pool.query('SELECT id FROM clients WHERE advisor_id=$1 ORDER BY name', [advisorId]);
  const lines = ['Klient;Monat;Freigaben mit Zeit;Minuten verbraucht;Minuten inbegriffen;Mehraufwand Minuten;Verrechnet Minuten;Mehraufwand CHF;Monatsabo CHF;Total CHF'];
  let total = 0;
  for (const c of cl) {
    const s = await clientSummary(c.id, month);
    if (!s || (!s.rows.length)) continue;
    total += s.extraChf;
    lines.push([`"${String(s.clientName).replace(/"/g, '""')}"`, s.month, s.rows.length, s.usedMinutes, s.includedMinutes, s.extraMinutes, s.billedMinutes, s.extraChf.toFixed(2), s.aboChf != null ? s.aboChf.toFixed(2) : '', s.totalChf != null ? s.totalChf.toFixed(2) : ''].join(';'));
  }
  lines.push(`Total Mehraufwand;;;;;;;${total.toFixed(2)};;`);
  return '﻿' + lines.join('\r\n');
}

module.exports = { clientSummary, setMinutes, exportCsv, monthRange, extraFor, PLAN_MINUTES, RATE_CHF, STEP };
