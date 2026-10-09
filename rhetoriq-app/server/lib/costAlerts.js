// Kostenwarnungen: je Klient pro Tag, je Klient pro Monat im Vergleich zum Abopreis und für die ganze Plattform pro Tag.
// Alle Beträge kommen aus den exakten Kosten im Nutzungsprotokoll (lib/meter.js).
const { pool } = require('../db');
const { COST_SQL } = require('./meter');

const DAILY_CLIENT_USD = parseFloat(process.env.COST_ALERT_THRESHOLD_USD) || 5;
const DAILY_PLATFORM_USD = parseFloat(process.env.PLATFORM_DAILY_ALERT_USD) || 25;
// Anteil der Monatsgebühr, ab dem die Warnung kommt (Standard: 35 Prozent)
const MONTHLY_SHARE = parseFloat(process.env.COST_ALERT_MONTHLY_SHARE) || 0.35;
// 1 Franken in US-Dollar (Standard 1.10), nur für den Vergleich mit dem Abopreis
const USD_PER_CHF = parseFloat(process.env.USD_PER_CHF) || 1.10;
const NOTIFY = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

// Abopreis in Franken je Monatskontingent (wie routes/subscriptions.js, Enterprise ohne Limit)
const PRICE_BY_LIMIT = { 300000: 290, 750000: 590, 1500000: 990 };
function planPriceChf(limit) { return limit ? (PRICE_BY_LIMIT[Number(limit)] || null) : 2490; }

const sent = new Set();
function once(key) { if (sent.has(key)) return false; sent.add(key); if (sent.size > 2000) sent.clear(); return true; }

async function mail(subject, text) {
  const { brevoSend } = require('./brevo');
  await brevoSend({ to: NOTIFY, subject, text, senderName: 'RhetorIQ' });
}

async function costOf(whereSql, params) {
  const { rows } = await pool.query(`SELECT COALESCE(SUM(${COST_SQL}),0)::float AS c FROM usage_log WHERE ${whereSql}`, params);
  return rows[0].c;
}

async function check(clientId) {
  try {
    const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
    // Kosten heute für diesen Klienten
    if (clientId) {
      const today = await costOf('client_id=$1 AND created_at::date = CURRENT_DATE', [clientId]);
      if (today >= DAILY_CLIENT_USD && once(`d:${clientId}:${day}`)) {
        const { rows } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
        const name = (rows[0] && rows[0].name) || `Klient ${clientId}`;
        await mail(`RhetorIQ Kostenwarnung: ${name} heute über $${DAILY_CLIENT_USD}`,
          `${name} hat heute bereits $${today.toFixed(2)} an KI-Kosten verursacht (Schwelle: $${DAILY_CLIENT_USD}).\n\nDetails unter Nutzung in der Plattform.`);
      }
      // Kosten im Monat im Vergleich zur Monatsgebühr
      const { rows: cr } = await pool.query('SELECT name, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
      const price = planPriceChf(cr[0] && cr[0].monthly_token_limit);
      if (price) {
        const monthCost = await costOf(`client_id=$1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`, [clientId]);
        const monthChf = monthCost / USD_PER_CHF;
        if (monthChf >= price * MONTHLY_SHARE && once(`m:${clientId}:${month}`)) {
          await mail(`RhetorIQ Kostenwarnung: ${cr[0].name} hat ${Math.round(MONTHLY_SHARE * 100)} % der Monatsgebühr verbraucht`,
            `${cr[0].name}: KI-Kosten diesen Monat rund CHF ${monthChf.toFixed(2)} ($${monthCost.toFixed(2)}) bei einer Monatsgebühr von CHF ${price}. Das sind ${Math.round(monthChf / price * 100)} % der Gebühr.\n\nPrüfe unter Nutzung, ob das Kontingent oder die Stufe passt.`);
        }
      }
    }
    // Ganze Plattform heute
    const total = await costOf('created_at::date = CURRENT_DATE', []);
    if (total >= DAILY_PLATFORM_USD && once(`p:${day}`)) {
      await mail(`RhetorIQ Kostenwarnung: Plattform heute über $${DAILY_PLATFORM_USD}`,
        `Die KI-Kosten der ganzen Plattform liegen heute bei $${total.toFixed(2)} (Schwelle: $${DAILY_PLATFORM_USD}).\n\nPrüfe unter Nutzung, welche Klienten und Module den Verbrauch treiben.`);
    }
  } catch (e) {
    console.error('[cost-alert] fehlgeschlagen:', e.message);
  }
}

module.exports = { check, planPriceChf, DAILY_CLIENT_USD, DAILY_PLATFORM_USD, MONTHLY_SHARE, USD_PER_CHF };
