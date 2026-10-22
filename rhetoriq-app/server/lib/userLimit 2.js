// Nutzerlimit je Paket: Stimme 1, Team 5, Business 15, Enterprise unbegrenzt. Zusatznutzer (CHF 49 pro Monat) erhöhen das Limit.
// Der Hauptzugang der Firma zählt als erste Person, Teammitglieder (client_users) kommen dazu.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');

const NAMES = { stimme: 'Stimme', team: 'Team', business: 'Business', enterprise: 'Enterprise' };
// Nach gebuchtem Monatskontingent (wie lib/costAlerts.js und routes/subscriptions.js)
const BY_TOKENS = { 200000: ['stimme', 1], 300000: ['stimme', 1], 750000: ['team', 5], 1500000: ['business', null], 2000000: ['business', 15] };
const BY_PLAN = { stimme: 1, team: 5, business: 15, enterprise: null };

// Liefert { plan, base } mit base = erlaubte Personen ohne Zusatznutzer (null = unbegrenzt, auch wenn noch kein Paket gesetzt ist)
function baseFor(c) {
  // Das Standardkontingent neuer Klienten (200000) soll ein bewusst gesetztes Paket nicht überstimmen
  if (Number(c.monthly_token_limit) === 200000 && c.recommended_plan && Object.prototype.hasOwnProperty.call(BY_PLAN, c.recommended_plan)) return { plan: c.recommended_plan, base: BY_PLAN[c.recommended_plan] };
  if (c.monthly_token_limit && BY_TOKENS[Number(c.monthly_token_limit)]) {
    const [plan, base] = BY_TOKENS[Number(c.monthly_token_limit)];
    return { plan, base };
  }
  if (c.recommended_plan && Object.prototype.hasOwnProperty.call(BY_PLAN, c.recommended_plan)) return { plan: c.recommended_plan, base: BY_PLAN[c.recommended_plan] };
  return { plan: null, base: null };
}

async function status(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT id, name, monthly_token_limit, recommended_plan, extra_users FROM clients WHERE id=$1', [clientId]);
  if (!rows[0]) return null;
  const { rows: u } = await pool.query('SELECT COUNT(*)::int AS n FROM client_users WHERE client_id=$1', [clientId]);
  const { plan, base } = baseFor(rows[0]);
  const extra = Number(rows[0].extra_users) || 0;
  const limit = base == null ? null : base + extra;
  const used = 1 + u[0].n; // Hauptzugang plus Teammitglieder
  return { clientId: rows[0].id, plan, planName: plan ? NAMES[plan] : null, base, extra, limit, used, full: limit != null && used >= limit };
}

module.exports = { status, baseFor, NAMES };
