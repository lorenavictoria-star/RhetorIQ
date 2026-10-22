// Harte Kostenbremse (Befund F-07): tägliche Obergrenze für die ganze Plattform und je Klient.
// Werte per Umgebungsvariable: COST_BRAKE_PLATFORM_DAILY_USD (Standard 40), COST_BRAKE_CLIENT_DAILY_USD (Standard 10).
// Die Beraterin selbst ist ausgenommen. Gelesen werden die exakten Kosten aus usage_log (lib/meter.js).
const { pool } = require('../db');
const { COST_SQL } = require('./meter');
const { mailAdvisor } = require('./notify');

const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) && x > 0 ? x : d; };
const limits = () => ({
  platform: num(process.env.COST_BRAKE_PLATFORM_DAILY_USD, 40),
  client: num(process.env.COST_BRAKE_CLIENT_DAILY_USD, 10)
});

const sent = new Set();
function once(key) { if (sent.has(key)) return false; sent.add(key); if (sent.size > 500) sent.clear(); return true; }

async function costToday(clientId) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const where = clientId ? 'client_id=$2 AND created_at >= $1' : 'created_at >= $1';
  const { rows } = await pool.query(`SELECT COALESCE(SUM(${COST_SQL}),0)::float AS c FROM usage_log WHERE ${where}`, clientId ? [start, clientId] : [start]);
  return rows[0].c;
}

// Liefert { ok:true } oder { ok:false, scope, error } (für HTTP 429). Fehler beim Prüfen sperren nie (offen bei Störung).
async function checkDailyCap(user, clientId) {
  try {
    if (!user || user.role === 'advisor') return { ok: true };
    const L = limits();
    const day = new Date().toISOString().slice(0, 10);
    const total = await costToday(null);
    if (total >= L.platform) {
      if (once('p:' + day)) {
        mailAdvisor('RhetorIQ Kostenbremse: Plattform hat die Tagesgrenze erreicht',
          `Die KI-Kosten der ganzen Plattform liegen heute bei $${total.toFixed(2)} (harte Grenze: $${L.platform}). Neue Anfragen von Klienten werden bis morgen abgewiesen.\n\nDie Grenze lässt sich mit COST_BRAKE_PLATFORM_DAILY_USD in Render anpassen. Die Beraterin selbst ist von der Sperre ausgenommen.`).catch(() => {});
      }
      return { ok: false, scope: 'platform', error: 'Die Plattform hat heute ihre Tagesgrenze für KI-Nutzung erreicht. Bitte versuchen Sie es morgen wieder oder melden Sie sich bei Ihrer Beraterin.' };
    }
    if (clientId) {
      const mine = await costToday(clientId);
      if (mine >= L.client) {
        if (once(`c:${clientId}:${day}`)) {
          const { rows } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
          const name = (rows[0] && rows[0].name) || `Klient ${clientId}`;
          mailAdvisor(`RhetorIQ Kostenbremse: ${name} hat die Tagesgrenze erreicht`,
            `${name} hat heute $${mine.toFixed(2)} an KI-Kosten verursacht (harte Grenze: $${L.client}). Weitere Anfragen dieses Klienten werden bis morgen abgewiesen.\n\nDie Grenze lässt sich mit COST_BRAKE_CLIENT_DAILY_USD in Render anpassen.`).catch(() => {});
        }
        return { ok: false, scope: 'client', error: 'Für heute ist die Tagesgrenze für KI-Nutzung erreicht. Ab morgen steht die Plattform wieder zur Verfügung. Bei Bedarf wenden Sie sich bitte an Ihre Beraterin.' };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('[cost-brake] Prüfung fehlgeschlagen:', e.message);
    return { ok: true };
  }
}

module.exports = { checkDailyCap, limits };
