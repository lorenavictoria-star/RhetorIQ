// Zeiterfassung für persönliche Bearbeitung: inbegriffene Minuten je Paket, Mehraufwand zu CHF 180 pro Stunde im 15-Minuten-Takt.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { planPriceChf } = require('./costAlerts');

const RATE_CHF = parseFloat(process.env.HOURLY_RATE_CHF) || 180;
const STEP = 15;
// Inbegriffene Minuten je Monat: Überarbeitungen mal 15 Minuten (Stimme 2, Team 6, Business 15), Enterprise 5 Stunden
const PLAN_MINUTES = { stimme: 30, team: 90, business: 225, enterprise: 300 };
const DEFAULT_PLAN = 'team';

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

// Reine Rechnung: Mehraufwand (Minuten) zuerst mit dem Guthaben der Karten verrechnen, älteste Karte zuerst.
// cards: [{ id, minuten_gesamt, minuten_verbraucht, gekauft_am }]. Verbraucht nichts, liefert nur die Aufteilung.
function cardsApply(extraMinutes, cards) {
  const sorted = [...(cards || [])].sort((a, b) => new Date(a.gekauft_am || 0) - new Date(b.gekauft_am || 0) || Number(a.id) - Number(b.id));
  let rest = Math.max(0, Math.round(Number(extraMinutes) || 0));
  const parts = [];
  let balance = 0;
  for (const c of sorted) {
    const free = Math.max(0, Number(c.minuten_gesamt) - Number(c.minuten_verbraucht || 0));
    balance += free;
    const take = Math.min(free, rest);
    if (take > 0) { parts.push({ id: c.id, minutes: take }); rest -= take; }
  }
  const cardMinutes = Math.max(0, Math.round(Number(extraMinutes) || 0)) - rest;
  const billedMin = Math.ceil(rest / STEP) * STEP;
  return { kartenMinuten: cardMinutes, restMinutes: rest, billedMinutes: billedMin, extraChf: Math.round(billedMin / 60 * RATE_CHF * 100) / 100, parts, guthabenMinuten: balance, guthabenNach: balance - cardMinutes };
}

async function loadCards(clientId) {
  const { rows } = await pool.query('SELECT id, minuten_gesamt, minuten_verbraucht, gekauft_am FROM ueberarbeitungskarten WHERE client_id=$1 ORDER BY gekauft_am ASC, id ASC', [clientId]);
  return rows;
}

async function clientSummary(clientId, month) {
  await ensureSchema();
  const r = monthRange(month);
  const { rows: c } = await pool.query('SELECT id, name, recommended_plan, included_minutes, monthly_token_limit, subscription_status FROM clients WHERE id=$1', [clientId]);
  if (!c[0]) return null;
  const poolMin = c[0].included_minutes != null ? Number(c[0].included_minutes) : (PLAN_MINUTES[c[0].recommended_plan] ?? PLAN_MINUTES[DEFAULT_PLAN]);
  const { rows } = await pool.query(
    `SELECT id, module_label, minutes, time_logged_at FROM review_requests
     WHERE client_id=$1 AND minutes IS NOT NULL AND time_logged_at >= $2 AND time_logged_at < $3 ORDER BY time_logged_at ASC`,
    [clientId, r.from, r.to]);
  const used = rows.reduce((s, x) => s + Number(x.minutes || 0), 0);
  // Monatsabo laut gebuchtem Kontingent (wie in den Kostenwarnungen), der Mehraufwand kommt oben drauf
  // Nur ein bezahltes Abo zählt als Umsatz. Ohne Zahlung (Test, ausstehend, gekündigt) gibt es keinen Abopreis, sonst stünde ohne Kontingent fälschlich Enterprise zu CHF 2490.
  const bezahlt = /^(active|past_due)$/i.test(String(c[0].subscription_status || ''));
  const aboChf = bezahlt ? planPriceChf(c[0].monthly_token_limit) : null;
  const ex0 = extraFor(used, poolMin);
  const cards = await loadCards(clientId);
  const { rows: closed } = await pool.query('SELECT karten_minuten, abgeschlossen_am FROM monatsabschluss WHERE client_id=$1 AND monat=$2', [clientId, r.month]);
  const guthaben = cards.reduce((s, x) => s + Math.max(0, Number(x.minuten_gesamt) - Number(x.minuten_verbraucht || 0)), 0);
  let ca;
  if (closed[0]) {
    // Abgeschlossener Monat: festgehaltene Kartenminuten, Guthaben ist schon abgezogen
    const km = Number(closed[0].karten_minuten) || 0, rest = Math.max(0, ex0.extraMinutes - km), bm = Math.ceil(rest / STEP) * STEP;
    ca = { kartenMinuten: km, billedMinutes: bm, extraChf: Math.round(bm / 60 * RATE_CHF * 100) / 100, guthabenMinuten: guthaben };
  } else {
    ca = cardsApply(ex0.extraMinutes, cards);
  }
  const ex = { extraMinutes: ex0.extraMinutes, billedMinutes: ca.billedMinutes, extraChf: ca.extraChf };
  return {
    month: r.month, aboChf, totalChf: aboChf != null ? Math.round((aboChf + ex.extraChf) * 100) / 100 : null, clientId: c[0].id, clientName: c[0].name, plan: c[0].recommended_plan || null,
    includedMinutes: poolMin, customIncluded: c[0].included_minutes != null, usedMinutes: used, rateChf: RATE_CHF, step: STEP,
    ...ex, extraChfVorKarte: ex0.extraChf, kartenMinuten: ca.kartenMinuten, guthabenMinuten: ca.guthabenMinuten,
    abgeschlossen: !!closed[0], abgeschlossenAm: closed[0] ? closed[0].abgeschlossen_am : null, rows
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

// Monat abschliessen: bucht den Kartenverbrauch genau einmal pro Klient und Monat.
async function closeMonth(clientId, month) {
  await ensureSchema();
  const r = monthRange(month);
  const s = await clientSummary(clientId, r.month);
  if (!s) return null;
  if (s.abgeschlossen) return { ...s, neu: false };
  const cards = await loadCards(clientId);
  const ca = cardsApply(s.extraMinutes, cards);
  // Der Eintrag mit eindeutigem Index gilt als Reservierung: wer ihn zuerst anlegt, bucht.
  try {
    await pool.query('INSERT INTO monatsabschluss (client_id, monat, karten_minuten) VALUES ($1,$2,$3)', [clientId, r.month, ca.kartenMinuten]);
  } catch (e) {
    return { ...(await clientSummary(clientId, r.month)), neu: false };
  }
  for (const p of ca.parts) {
    await pool.query('UPDATE ueberarbeitungskarten SET minuten_verbraucht = minuten_verbraucht + $1 WHERE id=$2', [p.minutes, p.id]);
  }
  return { ...(await clientSummary(clientId, r.month)), neu: true };
}

async function exportCsv(advisorId, month) {
  await ensureSchema();
  const { rows: cl } = await pool.query('SELECT id FROM clients WHERE advisor_id=$1 AND geloescht_am IS NULL ORDER BY name', [advisorId]);
  const lines = ['Klient;Monat;Freigaben mit Zeit;Minuten verbraucht;Minuten inbegriffen;Mehraufwand Minuten;Verrechnet Minuten;Karte abgezogen Minuten;Mehraufwand CHF;Monatsabo CHF;Total CHF'];
  let total = 0;
  for (const c of cl) {
    const s = await clientSummary(c.id, month);
    if (!s || (!s.rows.length)) continue;
    total += s.extraChf;
    lines.push([`"${String(s.clientName).replace(/"/g, '""')}"`, s.month, s.rows.length, s.usedMinutes, s.includedMinutes, s.extraMinutes, s.billedMinutes, s.kartenMinuten, s.extraChf.toFixed(2), s.aboChf != null ? s.aboChf.toFixed(2) : '', s.totalChf != null ? s.totalChf.toFixed(2) : ''].join(';'));
  }
  lines.push(`Total Mehraufwand;;;;;;;;${total.toFixed(2)};;`);
  return '﻿' + lines.join('\r\n');
}

module.exports = { cardsApply, closeMonth, loadCards, clientSummary, setMinutes, exportCsv, monthRange, extraFor, PLAN_MINUTES, RATE_CHF, STEP };
