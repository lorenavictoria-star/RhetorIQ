const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient, ownClientBody } = require('../middleware/ownership');
const yearly = require('../lib/yearlyPlan');
const { ensureSchema } = require('../lib/schemaRedesign');

// 10er-Karte Überarbeitungen: 10 mal 30 Minuten, CHF 690, verfällt nicht
const KARTE = { amountCents: 69000, minutes: 300, label: '10er-Karte Überarbeitungen (10 mal 30 Minuten)' };

// Zusatzmodul «Automatisch Themen und Ideen senden» (Themenplan und Newsletter-Entwurf), CHF 150 pro Monat
const THEMENPLAN = { amountCents: 15000, label: 'Automatisch Themen und Ideen senden (Themenplan und Newsletter)' };

const router = express.Router();

// ── Stripe helpers ────────────────────────────────────────────
let stripeOverride = null; // Tests setzen hier eine Attrappe
function getStripe() {
  if (stripeOverride) return stripeOverride;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ── DB migration: ensure subscription_status column exists ────
// Called once on first use; safe to call multiple times.
let migrationDone = false;
async function ensureColumn() {
  if (migrationDone) return;
  await pool.query(
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'`
  );
  // Needed to open a Stripe Customer Portal session for a client later (portal
  // sessions are keyed by Stripe Customer ID, not by our own client ID).
  await pool.query(
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`
  );
  migrationDone = true;
}

// ── GET /api/subscriptions/prices ──────────────────────────────
// Lists active Stripe Prices so the advisor can pick one from a dropdown
// instead of typing a raw Price ID.
router.get('/prices', requireAdvisor, async (req, res) => {
  try {
    const stripe = getStripe();
    const prices = await stripe.prices.list({ active: true, limit: 50, expand: ['data.product'] });
    const list = prices.data
      .filter(p => p.product && p.product.active !== false)
      .map(p => ({
        id: p.id,
        productName: p.product.name,
        amount: p.unit_amount,
        currency: p.currency,
        recurring: p.recurring ? p.recurring.interval : null,
      }));
    res.json(list);
  } catch (e) {
    console.error('[stripe] list prices error:', e.message);
    res.status(500).json({ error: 'Could not load Stripe prices' });
  }
});

// ── POST /api/subscriptions/create-payment-link/:clientId ─────
// Advisor creates a Stripe Payment Link for a client.
router.post('/create-payment-link/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    const { rows } = await pool.query('SELECT id, name FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const stripe = getStripe();

    // Build a payment link. Advisor can pass priceId in body, or we use a default.
    // For a recurring subscription: pass a Price ID with type=recurring.
    // For a one-time payment: pass a Price ID with type=one_time.
    const { priceId, angebot } = req.body;
    // Eingebaute Angebote (Pakete, Stimm-Audit, Workshop): Preis direkt im Aufruf, keine Vorbereitung in Stripe nötig
    const ang = angebot ? require('../lib/angebote').ANGEBOTE[String(angebot)] : null;
    if (angebot && !ang) return res.status(400).json({ error: 'Unbekanntes Angebot.' });
    if (!priceId && !ang) return res.status(400).json({ error: 'priceId oder angebot erforderlich' });

    if (ang) {
      const meta = { clientId: String(clientId), clientName: rows[0].name, angebot: String(angebot) };
      if (ang.einrichtung) meta.type = 'einrichtung';
      if (ang.zusatz) meta.type = ang.zusatz;
      const p2 = {
        line_items: [{ price_data: { currency: 'chf', unit_amount: ang.amountCents, ...(ang.recurring ? { recurring: { interval: 'month', ...(ang.intervalCount ? { interval_count: ang.intervalCount } : {}) } } : {}), product_data: { name: `RhetorIQ ${ang.name} — ${rows[0].name}` } }, quantity: 1 }],
        metadata: meta
      };
      if (ang.recurring) p2.subscription_data = { metadata: { clientId: String(clientId), clientName: rows[0].name, ...(ang.zusatz ? { type: ang.zusatz } : {}) } };
      const l2 = await stripe.paymentLinks.create(p2);
      return res.json({ url: l2.url, angebot: String(angebot), amountCents: ang.amountCents });
    }

    const params = {
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { clientId: String(clientId), clientName: rows[0].name },
    };
    // Bei wiederkehrenden Preisen die Klientennummer auch am Abo hinterlegen, damit eine Kündigung zuordenbar bleibt
    try {
      const price = stripe.prices && stripe.prices.retrieve ? await stripe.prices.retrieve(priceId) : null;
      if (price && price.recurring) params.subscription_data = { metadata: { clientId: String(clientId), clientName: rows[0].name } };
    } catch (e) { console.error('[stripe] Preis konnte nicht geprüft werden:', e.message); }
    const link = await stripe.paymentLinks.create(params);

    res.json({ url: link.url });
  } catch (e) {
    console.error('[stripe] create-payment-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/subscriptions/angebote ───────────────────────────
// Liste der eingebauten Angebote für die Auswahl beim Zahlungslink (nur Beraterin)
router.get('/angebote', requireAdvisor, (req, res) => res.json(require('../lib/angebote').LISTE));

// ── GET /api/subscriptions/status/:clientId ───────────────────
router.get('/status/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    const { rows } = await pool.query(
      'SELECT subscription_status FROM clients WHERE id=$1',
      [clientId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ subscription_status: rows[0].subscription_status || 'trial' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/mark-active/:clientId ────────────
// Advisor manually marks a client as active (paid).
router.post('/mark-active/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    await ensureSchema();
    await pool.query(
      `UPDATE clients SET subscription_status='active', zugang_bis=NULL WHERE id=$1`,
      [clientId]
    );
    res.json({ ok: true, subscription_status: 'active' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Pricing tiers → monthly token quota ────────────────────────
// Matched by the exact CHF amount charged (in Rappen) rather than a Stripe
// Price ID, so this keeps working even if a price gets recreated/edited in
// Stripe. Keep in sync with the actual prices configured there.
// ~5'000 tokens per text as a buffer (covers longer formats like
// presentations, not just short emails).
const TIERS = [
  { name: 'Stimme', amountCents: 19000, tokens: 200000 },      // 40 Texte/Monat
  { name: 'Team', amountCents: 59000, tokens: 750000 },        // 150 Texte/Monat
  { name: 'Business', amountCents: 149000, tokens: 2000000 },  // 400 Texte/Monat
  { name: 'Enterprise', amountCents: 249000, tokens: null },   // unbegrenzt, auf Anfrage
];
// Frühere Abos (Starter CHF 290, Team CHF 990) laufen mit ihrem bisherigen Kontingent weiter.
const LEGACY_PRICE_LIMITS = { 29000: 300000, 99000: 1500000 };
const PRICE_TIER_TOKEN_LIMITS = { ...LEGACY_PRICE_LIMITS, ...Object.fromEntries(TIERS.map(t => [t.amountCents, t.tokens])) };
function resolveTokenLimit(amountInCents, currency) {
  if (!amountInCents || (currency || '').toLowerCase() !== 'chf') return undefined;
  if (PRICE_TIER_TOKEN_LIMITS.hasOwnProperty(amountInCents)) return PRICE_TIER_TOKEN_LIMITS[amountInCents];
  // Jahrespreise (10 % Rabatt) setzen dasselbe Monatskontingent
  return yearly.resolveYearlyLimit(amountInCents, currency);
}

// One-time self-serve top-up, offered to a client the moment they hit their
// monthly quota — covers the current month only (see usage_topups table),
// doesn't change their recurring plan.
// +20 Texte für CHF 49 (20 Texte zu 5'000 Tokens, wie das Kontingent der Pakete gerechnet ist)
const TOPUP = { amountCents: 4900, tokens: 100000, label: 'Zusatzpaket +20 Texte' };

// ── POST /api/subscriptions/skip-plan/:clientId ─────────────────
// Client chose "Später entscheiden" on the setup page instead of paying
// right away. Marks them explicitly as pending-plan so generation is
// gated until they pick one — distinct from 'trial', which existing/
// advisor-managed clients keep and which is never gated.
router.post('/skip-plan/:clientId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(`UPDATE clients SET subscription_status='pending_plan' WHERE id=$1`, [clientId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[stripe] skip-plan error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/topup-link/:clientId ────────────────
// Self-serve: client hit their monthly quota and wants to buy a one-time
// top-up right now, without waiting on the advisor. No pre-created Stripe
// Price needed — price_data builds it inline.
router.post('/topup-link/:clientId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query('SELECT id, name FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const stripe = getStripe();
    const link = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'chf',
          unit_amount: TOPUP.amountCents,
          product_data: { name: `RhetorIQ ${TOPUP.label} — ${rows[0].name}` },
        },
        quantity: 1,
      }],
      metadata: { clientId: String(clientId), clientName: rows[0].name, type: 'topup', tokens: String(TOPUP.tokens) },
    });
    res.json({ url: link.url, tokens: TOPUP.tokens, amountCents: TOPUP.amountCents });
  } catch (e) {
    console.error('[stripe] topup-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/karte-link/:clientId ────────────────
// Einmaliger Zahlungslink für die 10er-Karte. Klienten nur für sich (Hauptzugang oder Admin), die Beraterin für ihre Klienten.
router.post('/karte-link/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    if (req.user.role === 'client' && req.user.clientUserRole && req.user.clientUserRole !== 'admin') return res.status(403).json({ error: 'Nicht erlaubt.' });
    const { clientId } = req.params;
    const { rows } = await pool.query('SELECT id, name FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const link = await getStripe().paymentLinks.create({
      line_items: [{ price_data: { currency: 'chf', unit_amount: KARTE.amountCents, product_data: { name: `RhetorIQ ${KARTE.label}, ${rows[0].name}` } }, quantity: 1 }],
      metadata: { clientId: String(clientId), clientName: rows[0].name, type: 'karte' },
    });
    res.json({ url: link.url, minutes: KARTE.minutes, amountCents: KARTE.amountCents });
  } catch (e) {
    console.error('[stripe] karte-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/upgrade-link/:clientId ──────────────
// Self-serve: client hit their monthly quota and wants to move up a tier
// right now. Builds a new recurring Payment Link for the next tier's price
// (no pre-created Stripe subscription Price needed) — the client pays and
// their subscription_status/monthly_token_limit update automatically via
// the webhook, same as any other payment.
// NOTE: this does not cancel the client's existing subscription in Stripe —
// check for and cancel the old one manually after an upgrade goes through,
// until a full Customer Portal / proration flow is wired up.
router.post('/upgrade-link/:clientId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query('SELECT id, name, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const currentLimit = rows[0].monthly_token_limit;
    // currentLimit is null both for "no plan assigned yet" and for an actual
    // Enterprise client (unlimited quota is stored as null too) — only match
    // a real, non-null tier value here so an unassigned client correctly
    // gets offered Starter as the next tier, instead of being treated as
    // already on Enterprise and blocked from upgrading at all.
    // Nächste Stufe = die erste mit grösserem Kontingent (so greift es auch für frühere Abos)
    const nextTier = currentLimit ? TIERS.find(t => t.tokens === null || t.tokens > currentLimit) : TIERS[0];
    if (!nextTier) {
      return res.status(400).json({ error: 'Bereits auf der höchsten Stufe — bitte direkt bei der Beraterin melden.' });
    }
    if (nextTier.tokens === null) return res.status(400).json({ error: 'Enterprise gibt es auf Anfrage. Bitte melden Sie sich bei Lorena.' });

    const stripe = getStripe();
    const link = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'chf',
          unit_amount: nextTier.amountCents,
          recurring: { interval: 'month' },
          product_data: { name: `RhetorIQ ${nextTier.name} Abo — ${rows[0].name}` },
        },
        quantity: 1,
      }],
      metadata: { clientId: String(clientId), clientName: rows[0].name, type: 'upgrade', targetTier: nextTier.name },
      subscription_data: { metadata: { clientId: String(clientId), clientName: rows[0].name } },
    });
    res.json({ url: link.url, tier: nextTier.name, amountCents: nextTier.amountCents });
  } catch (e) {
    console.error('[stripe] upgrade-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Zusatz «Quartalsreview» (CHF 290 alle 3 Monate, Abo mit Intervall 3 Monate) ─────────────
// Nur für die Pakete Stimme und Team. Business und Enterprise haben das Gespräch im Paket.
// Gekündigt wird über das Kundenportal (portal-link). Der Webhook setzt und entfernt clients.quartalsreview_aktiv.
async function quartalsOffer(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT id, name, monthly_token_limit, recommended_plan, quartalsreview_aktiv FROM clients WHERE id=$1', [clientId]);
  if (!rows.length) return null;
  const plan = require('../lib/userLimit').baseFor(rows[0]).plan;
  return { client: rows[0], plan, available: plan === 'stimme' || plan === 'team', aktiv: rows[0].quartalsreview_aktiv === true };
}

// POST /api/subscriptions/quartalsreview-link/:clientId
router.post('/quartalsreview-link/:clientId', requireAuth, nurKlientenAdmin, nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const o = await quartalsOffer(clientId);
    if (!o) return res.status(404).json({ error: 'Client not found' });
    if (!o.available) return res.status(400).json({ error: 'Das Quartalsreview ist bei Business und Enterprise im Paket enthalten. Als Zusatz gibt es es für die Pakete Stimme und Team.' });
    if (o.aktiv) return res.status(400).json({ error: 'Der Zusatz Quartalsreview ist bereits gebucht. Verwalten und kündigen können Sie ihn über das Kundenportal.' });
    const a = require('../lib/angebote').ANGEBOTE.quartalsreview;
    const meta = { clientId: String(clientId), clientName: o.client.name, type: a.zusatz };
    const link = await getStripe().paymentLinks.create({
      line_items: [{ price_data: { currency: 'chf', unit_amount: a.amountCents, recurring: { interval: 'month', interval_count: a.intervalCount }, product_data: { name: `RhetorIQ ${a.name}, ${o.client.name}` } }, quantity: 1 }],
      metadata: meta,
      subscription_data: { metadata: { ...meta } }
    });
    res.json({ url: link.url, amountCents: a.amountCents, intervalMonths: a.intervalCount });
  } catch (e) {
    console.error('[stripe] quartalsreview-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/subscriptions/yearly-offer/:clientId  (Gibt es für das Paket eine Jahreszahlung? Preise zur Anzeige)
router.get('/yearly-offer/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT monthly_token_limit FROM clients WHERE id=$1', [req.params.clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const o = yearly.yearlyOfferFor(rows[0].monthly_token_limit);
    res.json(o ? { available: true, tier: o.name, yearlyCents: o.yearlyCents, monthlyCents: o.monthlyCents } : { available: false });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── POST /api/subscriptions/yearly-link/:clientId ───────────────
// Jahresabo mit einheitlich 10 % Rabatt. Das Paket ergibt sich aus dem Monatskontingent.
// Klient nur für sich selbst, Beraterin für ihre Klienten.
router.post('/yearly-link/:clientId', requireAuth, requireRole('admin'), ownClient('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows } = await pool.query('SELECT id, name, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const offer = yearly.yearlyOfferFor(rows[0].monthly_token_limit);
    if (!offer) return res.status(400).json({ error: 'Für Ihr Paket gibt es keine Jahreszahlung im Selbstbedienungsweg. Bitte melden Sie sich bei Lorena.' });
    res.json(await yearly.createYearlyLink(getStripe(), rows[0], offer));
  } catch (e) {
    console.error('[stripe] yearly-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/choose-plan/:clientId ───────────────
// Self-serve: client picks a plan on the setup page (right after setting
// their password) and pays for it themselves. Any of the four tiers can be
// chosen directly, unlike upgrade-link which only offers the next one up.
router.post('/choose-plan/:clientId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { tier } = req.body;
    const chosen = TIERS.find(t => t.name === tier);
    if (!chosen) return res.status(400).json({ error: 'Unbekannter Plan' });
    if (chosen.tokens === null) return res.status(400).json({ error: 'Enterprise gibt es auf Anfrage. Bitte melden Sie sich bei Lorena.' });

    const { rows } = await pool.query('SELECT id, name FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const stripe = getStripe();
    const link = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'chf',
          unit_amount: chosen.amountCents,
          recurring: { interval: 'month' },
          product_data: { name: `RhetorIQ ${chosen.name} Abo — ${rows[0].name}` },
        },
        quantity: 1,
      }],
      after_completion: { type: 'redirect', redirect: { url: 'https://rhetoriq.ch/?welcome=1' } },
      metadata: { clientId: String(clientId), clientName: rows[0].name, type: 'choose-plan', targetTier: chosen.name },
      subscription_data: { metadata: { clientId: String(clientId), clientName: rows[0].name } },
    });
    res.json({ url: link.url, tier: chosen.name, amountCents: chosen.amountCents });
  } catch (e) {
    console.error('[stripe] choose-plan error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Selbstbuchung und Abo-Übersicht (Bereich «Abo verwalten») ────────────
// Nur die Rolle Admin des Klienten (Hauptzugang oder Team-Admin), nur für den eigenen Klienten.
const SELBST_PAKETE = ['stimme', 'team', 'business'];
function nurKlientenAdmin(req, res, next) {
  const { effectiveRank, RANK } = require('../middleware/roles');
  if (!req.user || req.user.role !== 'client' || effectiveRank(req.user) < RANK.admin) {
    return res.status(403).json({ error: 'Das Abo verwaltet die Rolle Admin Ihres Unternehmens.' });
  }
  next();
}
function nichtNurLesend(req, res, next) {
  if (req.user && req.user.readOnly) return res.status(403).json({ error: 'In dieser Ansicht lässt sich nichts buchen.' });
  next();
}

// GET /api/subscriptions/abo/:clientId: Stand, Nutzung, Hinweise und Angebote für «Abo verwalten»
router.get('/abo/:clientId', requireAuth, nurKlientenAdmin, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    const abo = require('../lib/abo');
    const row = await abo.clientRow(req.params.clientId);
    if (!row) return res.status(404).json({ error: 'Client not found' });
    const v = await abo.verbrauch(row.id, row.monthly_token_limit);
    const { baseFor, NAMES } = require('../lib/userLimit');
    const { plan } = baseFor({ monthly_token_limit: row.monthly_token_limit, recommended_plan: null });
    const z = abo.zugang(row);
    const hatAbo = (row.subscription_status === 'active' || row.subscription_status === 'past_due') && !row.zugang_bis;
    const o = yearly.yearlyOfferFor(row.monthly_token_limit);
    res.json({
      status: row.subscription_status || 'trial',
      aktiv: z.ok,
      hatAbo,
      paket: hatAbo && plan ? { key: plan, name: NAMES[plan] } : null,
      zugangBis: row.zugang_bis || null,
      nutzung: {
        unbegrenzt: v.unbegrenzt,
        verbraucht: abo.texte(v.used),
        kontingent: v.unbegrenzt ? null : abo.texte(v.limit),
        verbleibend: v.unbegrenzt ? null : Math.max(0, abo.texte(v.limit) - abo.texte(v.used)),
        prozent: v.prozent,
        zusatzTexte: abo.texte(v.topup)
      },
      hinweise: abo.hinweise(row, v),
      pakete: SELBST_PAKETE.map(k => {
        const t = TIERS.find(x => x.name.toLowerCase() === k);
        return { key: k, name: t.name, amountCents: t.amountCents, texte: t.tokens / abo.TOKENS_PRO_TEXT, nutzer: { stimme: 1, team: 5, business: 15 }[k], jahrCents: yearly.YEARLY.find(y => y.name === t.name).yearlyCents };
      }),
      enterprise: { aufAnfrage: true },
      jahresabo: o ? { verfuegbar: true, paket: o.name, jahrCents: o.yearlyCents, monatCents: o.monthlyCents } : { verfuegbar: false },
      zusatz: { texte: TOPUP.tokens / abo.TOKENS_PRO_TEXT, amountCents: TOPUP.amountCents },
      karte: { amountCents: KARTE.amountCents, minuten: KARTE.minutes },
      quartalsreview: await (async () => { const o = await quartalsOffer(row.id); const a = require('../lib/angebote').ANGEBOTE.quartalsreview; return { verfuegbar: !!(o && o.available), imPaket: !!(o && (o.plan === 'business' || o.plan === 'enterprise')), aktiv: !!(o && o.aktiv), amountCents: a.amountCents, intervalMonths: a.intervalCount }; })(),
      themenplan: { aktiv: !!(await pool.query('SELECT themenplan_aktiv FROM clients WHERE id=$1', [row.id])).rows[0]?.themenplan_aktiv, amountCents: THEMENPLAN.amountCents },
      portal: !!row.stripe_customer_id
    });
  } catch (e) {
    console.error('[abo] Übersicht:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscriptions/selbst-buchen/:clientId  { paket: 'stimme'|'team'|'business', jahr?: boolean }
router.post('/selbst-buchen/:clientId', requireAuth, nurKlientenAdmin, nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    const paket = String((req.body && req.body.paket) || '').toLowerCase();
    if (paket === 'enterprise') return res.status(400).json({ error: 'Enterprise gibt es auf Anfrage. Bitte melden Sie sich bei Lorena.' });
    if (!SELBST_PAKETE.includes(paket)) return res.status(400).json({ error: 'Dieses Angebot lässt sich nicht selbst buchen. Bitte melden Sie sich bei Lorena.' });
    const abo = require('../lib/abo');
    const row = await abo.clientRow(req.params.clientId);
    if (!row) return res.status(404).json({ error: 'Client not found' });
    const hatAbo = (row.subscription_status === 'active' || row.subscription_status === 'past_due') && !row.zugang_bis;
    if (hatAbo) return res.status(409).json({ error: 'Sie haben bereits ein Abo. Für einen Wechsel nutzen Sie «Auf höheres Paket wechseln» oder das Kundenportal.' });
    const ang = require('../lib/angebote').ANGEBOTE[paket];
    const stripe = getStripe();
    if (req.body && req.body.jahr) {
      const offer = yearly.YEARLY.find(y => y.name.toLowerCase() === paket);
      return res.json({ ...(await yearly.createYearlyLink(stripe, row, offer)), paket, jahr: true });
    }
    const meta = { clientId: String(row.id), clientName: row.name, type: 'selbstbuchung', angebot: paket };
    const link = await stripe.paymentLinks.create({
      line_items: [{ price_data: { currency: 'chf', unit_amount: ang.amountCents, recurring: { interval: 'month' }, product_data: { name: `RhetorIQ ${ang.name}, ${row.name}` } }, quantity: 1 }],
      after_completion: { type: 'redirect', redirect: { url: 'https://rhetoriq.ch/?abo=ok' } },
      metadata: meta,
      subscription_data: { metadata: { clientId: String(row.id), clientName: row.name } }
    });
    res.json({ url: link.url, paket, amountCents: ang.amountCents, jahr: false });
  } catch (e) {
    console.error('[stripe] selbst-buchen error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscriptions/themenplan-link/:clientId
// Zusatzmodul «Automatisch Themen und Ideen senden»: wiederkehrend monatlich, kündbar im Kundenportal.
// Nur die Rolle Admin des eigenen Klienten. Aktiviert wird erst nach der Zahlung (Webhook).
router.post('/themenplan-link/:clientId', requireAuth, nurKlientenAdmin, nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try {
    await ensureColumn();
    await ensureSchema();
    const { rows } = await pool.query('SELECT id, name, themenplan_aktiv FROM clients WHERE id=$1', [req.params.clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    if (rows[0].themenplan_aktiv) return res.status(409).json({ error: 'Dieses Zusatzmodul ist bereits aktiv. Kündigen können Sie es im Kundenportal.' });
    const meta = { clientId: String(rows[0].id), clientName: rows[0].name, type: 'themenplan' };
    const link = await getStripe().paymentLinks.create({
      line_items: [{ price_data: { currency: 'chf', unit_amount: THEMENPLAN.amountCents, recurring: { interval: 'month' }, product_data: { name: `RhetorIQ ${THEMENPLAN.label}, ${rows[0].name}` } }, quantity: 1 }],
      after_completion: { type: 'redirect', redirect: { url: 'https://rhetoriq.ch/?abo=ok' } },
      metadata: meta,
      subscription_data: { metadata: meta }
    });
    res.json({ url: link.url, amountCents: THEMENPLAN.amountCents });
  } catch (e) {
    console.error('[stripe] themenplan-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/portal-link/:clientId ───────────────
// Self-serve cancellation/management: opens Stripe's hosted Customer Portal,
// where the client can cancel or view their subscription themselves without
// the advisor doing it manually in Stripe. Requires stripe_customer_id to
// already be on file, which the webhook captures at first payment.
router.post('/portal-link/:clientId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query('SELECT stripe_customer_id FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!rows[0].stripe_customer_id) {
      return res.status(400).json({ error: 'Noch kein aktives Abo hinterlegt — bitte bei der Beraterin melden.' });
    }
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: 'https://rhetoriq.ch/login',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe] portal-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/webhook ──────────────────────────
// Stripe webhook. Must receive raw body — mount BEFORE express.json() in index.js.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Ohne STRIPE_WEBHOOK_SECRET wird nichts angenommen (kein "Dev mode" mehr, Befund F-15)
  if (!webhookSecret) {
    console.error('[stripe] webhook abgelehnt: STRIPE_WEBHOOK_SECRET ist nicht gesetzt');
    return res.status(400).json({ error: 'Webhook nicht konfiguriert.' });
  }
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    console.error('[stripe] webhook signature error:', e.message);
    return res.status(400).json({ error: 'Ungültige Signatur.' });
  }

  // Wiederholungsschutz: jede Ereignis-Nummer wird höchstens einmal verarbeitet
  let claimedEventId = null;
  try {
    if (event.id) {
      await ensureSchema();
      try {
        await pool.query('INSERT INTO stripe_events (event_id, type) VALUES ($1,$2)', [String(event.id), String(event.type || '')]);
      } catch (e) {
        if (e && e.code === '23505') {
          console.log(`[stripe] Ereignis ${event.id} bereits verarbeitet, übersprungen`);
          return res.json({ received: true, duplicate: true });
        }
        throw e;
      }
      claimedEventId = String(event.id);
    }
  } catch (e) {
    console.error('[stripe] Wiederholungsschutz nicht verfügbar:', e.message);
  }

  try {
    await ensureColumn();

    // Zusatz «Quartalsreview»: Typ und Klient stehen am Abo (subscription_data.metadata). Bei Rechnungen liegen sie in subscription_details.
    const qrMeta = o => {
      const m = [o && o.metadata, o && o.subscription_details && o.subscription_details.metadata, o && o.lines && o.lines.data && o.lines.data[0] && o.lines.data[0].metadata].find(x => x && x.type === 'quartalsreview');
      return m || null;
    };
    const setQuartalsFlag = async (clientId, an) => {
      await ensureSchema();
      await pool.query('UPDATE clients SET quartalsreview_aktiv=$2 WHERE id=$1', [clientId, an]);
      console.log(`[stripe] client ${clientId} → Zusatz Quartalsreview ${an ? 'aktiv' : 'beendet'} (${event.type})`);
    };
    const qrClient = async o => {
      const m = qrMeta(o);
      if (!m) return null;
      if (m.clientId) return m.clientId;
      if (o.customer) {
        const f = await pool.query('SELECT id FROM clients WHERE stripe_customer_id=$1', [String(o.customer)]);
        if (f.rows.length === 1) return f.rows[0].id;
      }
      return null;
    };

    if ((event.type === 'checkout.session.completed' || event.type === 'invoice.paid') && qrMeta(event.data.object)) {
      // Zusatz Quartalsreview bezahlt: nur das Flag setzen, Paket, Status und Kontingent bleiben unverändert
      const obj = event.data.object;
      const clientId = await qrClient(obj);
      if (clientId) {
        if (obj.customer) await pool.query('UPDATE clients SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE id=$1', [clientId, obj.customer]);
        await setQuartalsFlag(clientId, true);
      } else console.error(`[stripe] Zusatz Quartalsreview ${event.id || ''} konnte keinem Klienten zugeordnet werden`);
    } else if (event.type === 'invoice.payment_failed' && qrMeta(event.data.object)) {
      // Zahlungsausfall: Flag zurücknehmen (eine spätere erfolgreiche Zahlung setzt es über invoice.paid wieder)
      const clientId = await qrClient(event.data.object);
      if (clientId) await setQuartalsFlag(clientId, false);
    } else if (event.type === 'customer.subscription.updated' && qrMeta(event.data.object)) {
      const st = event.data.object.status;
      if (['past_due', 'unpaid', 'canceled', 'incomplete_expired'].includes(st)) {
        const clientId = await qrClient(event.data.object);
        if (clientId) await setQuartalsFlag(clientId, false);
      }
    } else if (event.type === 'customer.subscription.deleted' && qrMeta(event.data.object)) {
      // Kündigung des Zusatzes: Flag zurücknehmen, das Paket des Klienten bleibt (subscription_status wird nicht angefasst)
      const clientId = await qrClient(event.data.object);
      if (clientId) await setQuartalsFlag(clientId, false);
      else console.error(`[stripe] Kündigung Quartalsreview ${event.id || ''} konnte keinem Klienten zugeordnet werden`);
    } else if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const obj = event.data.object;
      // clientId stored in metadata at payment-link creation time
      const clientId = obj.metadata?.clientId;
      const isTopup = obj.metadata?.type === 'topup';
      const isKarte = obj.metadata?.type === 'karte';
      // Save the Stripe Customer ID the first time we see it, so the client
      // can later open the Customer Portal to manage/cancel their own
      // subscription (portal sessions are keyed by Customer ID, not by ours).
      if (clientId && obj.customer && obj.metadata?.type !== 'themenplan') {
        await pool.query('UPDATE clients SET stripe_customer_id=$2 WHERE id=$1', [clientId, obj.customer]);
      }
      // Zusatzmodul Themenplan: schaltet nur den Schalter, nie das Paket oder das Kontingent
      const tpMeta = { ...(obj.subscription_details?.metadata || {}), ...(obj.metadata || {}) };
      if (tpMeta.type === 'themenplan') {
        if (tpMeta.clientId) {
          await ensureSchema();
          await pool.query('UPDATE clients SET themenplan_aktiv=TRUE WHERE id=$1', [tpMeta.clientId]);
          if (obj.customer) await pool.query('UPDATE clients SET stripe_customer_id=COALESCE(stripe_customer_id,$2) WHERE id=$1', [tpMeta.clientId, obj.customer]);
          console.log(`[stripe] client ${tpMeta.clientId} → Themenplan aktiv (${event.type})`);
        }
      } else if (clientId && isKarte) {
        // 10er-Karte: nur beim abgeschlossenen Checkout, jede Stripe-Sitzung legt höchstens eine Karte an
        if (event.type === 'checkout.session.completed') {
          await ensureSchema();
          const ref = obj.id || obj.payment_intent;
          if (ref) {
            const ins = await pool.query('SELECT id FROM ueberarbeitungskarten WHERE stripe_ref=$1', [String(ref)]);
            if (!ins.rows.length) {
              try {
                await pool.query('INSERT INTO ueberarbeitungskarten (client_id, minuten_gesamt, stripe_ref) VALUES ($1,$2,$3)', [clientId, KARTE.minutes, String(ref)]);
                console.log(`[stripe] client ${clientId} → neue 10er-Karte (${ref})`);
              } catch (e) { /* gleichzeitige Zustellung: der eindeutige Index hat die zweite Karte verhindert */ }
            }
          }
        }
      } else if (clientId && obj.metadata?.type === 'einrichtung') {
        // Einrichtung (Stimm-Audit, Workshop): einmalige Zahlung. Das Stimm-Audit schaltet 30 Tage Zugang mit 40 Texten frei,
        // das Abo Stimme folgt danach mit eigenem Link. Workshops ändern nichts am Abo.
        if (event.type === 'checkout.session.completed' && obj.metadata.angebot === 'stimm-audit') {
          await ensureSchema();
          await pool.query(`UPDATE clients SET subscription_status='active', monthly_token_limit=200000, zugang_bis=NOW() + INTERVAL '30 days' WHERE id=$1`, [clientId]);
          console.log(`[stripe] client ${clientId} → Stimm-Audit bezahlt, 30 Tage mit 40 Texten`);
        } else {
          console.log(`[stripe] client ${clientId} → Einrichtung bezahlt (${obj.metadata.angebot || 'unbekannt'}), Abo unverändert`);
        }
      } else if (clientId && isTopup) {
        // One-time top-up: add tokens for the current month only, never
        // touch the recurring monthly_token_limit.
        const tokens = parseInt(obj.metadata.tokens, 10) || 0;
        if (tokens > 0) {
          await pool.query('INSERT INTO usage_topups (client_id, tokens) VALUES ($1,$2)', [clientId, tokens]);
          console.log(`[stripe] client ${clientId} → +${tokens} top-up tokens for this month (${event.type})`);
        }
      } else if (clientId) {
        // Figure out which plan was paid for, from the actual amount charged,
        // and apply the matching monthly token quota. Renewals hit this too
        // (invoice.paid), so an upgrade/downgrade takes effect automatically
        // at the next billing cycle, not just at first signup.
        const amount = event.type === 'checkout.session.completed' ? obj.amount_total : obj.amount_paid;
        const tokenLimit = resolveTokenLimit(amount, obj.currency);
        if (tokenLimit !== undefined) {
          await pool.query(
            `UPDATE clients SET subscription_status='active', monthly_token_limit=$2, zugang_bis=NULL WHERE id=$1`,
            [clientId, tokenLimit]
          );
          console.log(`[stripe] client ${clientId} → active, monthly_token_limit=${tokenLimit} (${event.type}, ${amount} ${obj.currency})`);
        } else {
          await pool.query(
            `UPDATE clients SET subscription_status='active', zugang_bis=NULL WHERE id=$1`,
            [clientId]
          );
          console.log(`[stripe] client ${clientId} → active, amount ${amount} ${obj.currency} matched no known tier — token limit left unchanged (${event.type})`);
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      // Zahlung fehlgeschlagen: Stripe versucht es erneut. Der Zugang bleibt, die Admin-Person sieht einen Hinweis (invoice.paid setzt wieder auf active).
      const obj = event.data.object;
      if ((obj.subscription_details?.metadata?.type || obj.metadata?.type) === 'themenplan') {
        console.log('[stripe] Zahlung für das Zusatzmodul Themenplan fehlgeschlagen, Stripe versucht es erneut');
        return res.json({ received: true });
      }
      let clientId = obj.metadata?.clientId || obj.subscription_details?.metadata?.clientId;
      if (!clientId && obj.customer) {
        const found = await pool.query('SELECT id FROM clients WHERE stripe_customer_id=$1', [String(obj.customer)]);
        if (found.rows.length === 1) clientId = found.rows[0].id;
      }
      if (clientId) {
        await pool.query(`UPDATE clients SET subscription_status='past_due' WHERE id=$1 AND subscription_status='active'`, [clientId]);
        console.log(`[stripe] client ${clientId} → past_due (Zahlung fehlgeschlagen)`);
      }
    } else if (event.type === 'customer.subscription.updated' && event.data.object.metadata?.type === 'themenplan') {
      // Zahlungsausfall am Ende der Mahnfrist: das Zusatzmodul wird zurückgenommen
      const obj = event.data.object;
      if (['unpaid', 'canceled', 'incomplete_expired'].includes(obj.status) && obj.metadata.clientId) {
        await ensureSchema();
        await pool.query('UPDATE clients SET themenplan_aktiv=FALSE WHERE id=$1', [obj.metadata.clientId]);
        console.log(`[stripe] client ${obj.metadata.clientId} → Themenplan aus (Status ${obj.status})`);
      }
    } else if (event.type === 'customer.subscription.deleted' && event.data.object.metadata?.type === 'themenplan') {
      // Kündigung des Zusatzmoduls: das Paket bleibt unberührt
      const obj = event.data.object;
      if (obj.metadata.clientId) {
        await ensureSchema();
        await pool.query('UPDATE clients SET themenplan_aktiv=FALSE WHERE id=$1', [obj.metadata.clientId]);
        console.log(`[stripe] client ${obj.metadata.clientId} → Themenplan gekündigt`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const obj = event.data.object;
      let clientId = obj.metadata?.clientId;
      // Payment Links geben die Metadaten nicht immer ans Abo weiter: dann über die gespeicherte Stripe-Kunden-Nummer zuordnen
      if (!clientId && obj.customer) {
        const found = await pool.query('SELECT id FROM clients WHERE stripe_customer_id=$1', [String(obj.customer)]);
        if (found.rows.length === 1) clientId = found.rows[0].id;
        else if (found.rows.length > 1) console.error(`[stripe] Kündigung für Kunde ${obj.customer}: mehrere Klienten gefunden, keine Änderung`);
      }
      if (clientId) {
        await pool.query(
          `UPDATE clients SET subscription_status='cancelled' WHERE id=$1`,
          [clientId]
        );
        console.log(`[stripe] client ${clientId} → cancelled`);
      } else {
        console.error(`[stripe] Kündigung ${event.id || ''} konnte keinem Klienten zugeordnet werden`);
        try { require('@sentry/node').captureMessage('Stripe-Kündigung ohne Klientenzuordnung'); } catch {}
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[stripe] webhook handler error:', e.message);
    if (claimedEventId) await pool.query('DELETE FROM stripe_events WHERE event_id=$1', [claimedEventId]).catch(() => {});
    try { require('@sentry/node').captureException(e); } catch {}
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Existing content-subscriptions routes (unchanged) ─────────

// GET /api/subscriptions?clientId=X  — load all for a client
router.get('/', requireAuth, ownClientBody('clientId'), async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const { rows } = await pool.query(
      'SELECT format, frequency, topic_hint, enabled, last_sent_at FROM content_subscriptions WHERE client_id=$1',
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscriptions  — upsert a subscription
router.post('/', requireAuth, requireRole('editor'), ownClientBody('clientId'), async (req, res) => {
  try {
    const { clientId, format, frequency, topicHint, enabled } = req.body;
    if (!clientId || !format) return res.status(400).json({ error: 'clientId and format required' });
    const { rows } = await pool.query(
      `INSERT INTO content_subscriptions (client_id, format, frequency, topic_hint, enabled)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_id, format) DO UPDATE
       SET frequency=EXCLUDED.frequency, topic_hint=EXCLUDED.topic_hint, enabled=EXCLUDED.enabled
       RETURNING *`,
      [clientId, format, frequency || 'weekly', topicHint || null, enabled !== false]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/subscriptions/due?clientId=X  — return formats that are due now
router.get('/due', requireAuth, ownClientBody('clientId'), async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const { rows } = await pool.query(
      `SELECT format, frequency, topic_hint FROM content_subscriptions
       WHERE client_id=$1 AND enabled=TRUE AND (
         last_sent_at IS NULL OR
         (frequency='weekly'   AND last_sent_at < NOW() - INTERVAL '7 days') OR
         (frequency='biweekly' AND last_sent_at < NOW() - INTERVAL '14 days') OR
         (frequency='monthly'  AND last_sent_at < NOW() - INTERVAL '30 days')
       )`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscriptions/mark-sent  — update last_sent_at
router.post('/mark-sent', requireAuth, requireRole('editor'), ownClientBody('clientId'), async (req, res) => {
  try {
    const { clientId, format } = req.body;
    await pool.query(
      'UPDATE content_subscriptions SET last_sent_at=NOW() WHERE client_id=$1 AND format=$2',
      [clientId, format]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.resolveTokenLimit = resolveTokenLimit;
module.exports._setStripe = (s) => { stripeOverride = s; };
