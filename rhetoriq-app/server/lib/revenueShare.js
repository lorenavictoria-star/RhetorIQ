// Klumpenrisiko: Umsatzanteil je Klient im Monat.
// Umsatz = Monatsabo laut gebuchtem Kontingent (costAlerts.planPriceChf; ohne Kontingent gilt Enterprise zu CHF 2490)
// plus Mehraufwand aus der Zeiterfassung (reviewTime.clientSummary). Richtwert: kein Klient über 40 Prozent.
const { pool } = require('../db');
const { clientSummary, monthRange } = require('./reviewTime');

const LIMIT_PERCENT = 40;

// Reine Rechnung (testbar): Liste {clientId, name, umsatzChf} -> Anteile
function shares(list, limit = LIMIT_PERCENT) {
  const total = list.reduce((s, x) => s + (x.umsatzChf > 0 ? x.umsatzChf : 0), 0);
  const rows = list.map(x => {
    const anteil = total > 0 && x.umsatzChf > 0 ? Math.round((x.umsatzChf / total) * 1000) / 10 : 0;
    return { ...x, anteilProzent: anteil, zu_hoch: anteil > limit };
  }).sort((a, b) => b.umsatzChf - a.umsatzChf);
  return { totalChf: Math.round(total * 100) / 100, limitProzent: limit, klienten: rows, zuHoch: rows.filter(r => r.zu_hoch) };
}

async function revenueShare(advisorId, month) {
  const m = monthRange(month).month;
  const { rows: cl } = await pool.query(
    `SELECT id, name, subscription_status FROM clients WHERE (advisor_id=$1 OR advisor_id IS NULL) ORDER BY name`, [advisorId]);
  const list = [];
  for (const c of cl) {
    if (/^cancel+ed$/i.test(String(c.subscription_status || ''))) continue;
    const s = await clientSummary(c.id, m);
    if (!s) continue;
    list.push({
      clientId: c.id, name: c.name, aboChf: s.aboChf, mehraufwandChf: s.extraChf,
      umsatzChf: s.totalChf != null ? s.totalChf : 0, kontingentUnbekannt: s.aboChf == null
    });
  }
  return { month: m, ...shares(list) };
}

module.exports = { revenueShare, shares, LIMIT_PERCENT };
