const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireAdvisor } = require('../middleware/auth');

const router = express.Router();

// ── Stripe helpers ────────────────────────────────────────────
function getStripe() {
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
router.post('/create-payment-link/:clientId', requireAdvisor, async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    const { rows } = await pool.query('SELECT id, name FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const stripe = getStripe();

    // Build a payment link. Advisor can pass priceId in body, or we use a default.
    // For a recurring subscription: pass a Price ID with type=recurring.
    // For a one-time payment: pass a Price ID with type=one_time.
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId required in request body' });

    const link = await stripe.paymentLinks.create({
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { clientId: String(clientId), clientName: rows[0].name },
    });

    res.json({ url: link.url });
  } catch (e) {
    console.error('[stripe] create-payment-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/subscriptions/status/:clientId ───────────────────
router.get('/status/:clientId', requireAdvisor, async (req, res) => {
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
router.post('/mark-active/:clientId', requireAdvisor, async (req, res) => {
  try {
    await ensureColumn();
    const { clientId } = req.params;
    await pool.query(
      `UPDATE clients SET subscription_status='active' WHERE id=$1`,
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
  { name: 'Starter', amountCents: 29000, tokens: 300000 },     // 60 Texte/Monat
  { name: 'Wachstum', amountCents: 59000, tokens: 750000 },    // 150 Texte/Monat
  { name: 'Team', amountCents: 99000, tokens: 1500000 },       // 300 Texte/Monat
  { name: 'Enterprise', amountCents: 249000, tokens: null },   // unbegrenzt
];
const PRICE_TIER_TOKEN_LIMITS = Object.fromEntries(TIERS.map(t => [t.amountCents, t.tokens]));
function resolveTokenLimit(amountInCents, currency) {
  if (!amountInCents || (currency || '').toLowerCase() !== 'chf') return undefined;
  return PRICE_TIER_TOKEN_LIMITS.hasOwnProperty(amountInCents) ? PRICE_TIER_TOKEN_LIMITS[amountInCents] : undefined;
}

// One-time self-serve top-up, offered to a client the moment they hit their
// monthly quota — covers the current month only (see usage_topups table),
// doesn't change their recurring plan.
const TOPUP = { amountCents: 9900, tokens: 100000, label: 'Kontingent-Zusatzpaket (+100\'000 Tokens)' };

// ── POST /api/subscriptions/topup-link/:clientId ────────────────
// Self-serve: client hit their monthly quota and wants to buy a one-time
// top-up right now, without waiting on the advisor. No pre-created Stripe
// Price needed — price_data builds it inline.
router.post('/topup-link/:clientId', requireAuth, async (req, res) => {
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

// ── POST /api/subscriptions/upgrade-link/:clientId ──────────────
// Self-serve: client hit their monthly quota and wants to move up a tier
// right now. Builds a new recurring Payment Link for the next tier's price
// (no pre-created Stripe subscription Price needed) — the client pays and
// their subscription_status/monthly_token_limit update automatically via
// the webhook, same as any other payment.
// NOTE: this does not cancel the client's existing subscription in Stripe —
// check for and cancel the old one manually after an upgrade goes through,
// until a full Customer Portal / proration flow is wired up.
router.post('/upgrade-link/:clientId', requireAuth, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query('SELECT id, name, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });

    const currentLimit = rows[0].monthly_token_limit;
    const currentIdx = TIERS.findIndex(t => t.tokens === currentLimit);
    const nextTier = TIERS[currentIdx + 1];
    if (!nextTier) {
      return res.status(400).json({ error: 'Bereits auf der höchsten Stufe — bitte direkt bei der Beraterin melden.' });
    }

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
    });
    res.json({ url: link.url, tier: nextTier.name, amountCents: nextTier.amountCents });
  } catch (e) {
    console.error('[stripe] upgrade-link error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/subscriptions/webhook ──────────────────────────
// Stripe webhook. Must receive raw body — mount BEFORE express.json() in index.js.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = getStripe();
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Dev mode: parse body directly (no signature verification)
      event = JSON.parse(req.body.toString());
    }
  } catch (e) {
    console.error('[stripe] webhook signature error:', e.message);
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  try {
    await ensureColumn();

    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const obj = event.data.object;
      // clientId stored in metadata at payment-link creation time
      const clientId = obj.metadata?.clientId;
      const isTopup = obj.metadata?.type === 'topup';
      if (clientId && isTopup) {
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
            `UPDATE clients SET subscription_status='active', monthly_token_limit=$2 WHERE id=$1`,
            [clientId, tokenLimit]
          );
          console.log(`[stripe] client ${clientId} → active, monthly_token_limit=${tokenLimit} (${event.type}, ${amount} ${obj.currency})`);
        } else {
          await pool.query(
            `UPDATE clients SET subscription_status='active' WHERE id=$1`,
            [clientId]
          );
          console.log(`[stripe] client ${clientId} → active, amount ${amount} ${obj.currency} matched no known tier — token limit left unchanged (${event.type})`);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const obj = event.data.object;
      const clientId = obj.metadata?.clientId;
      if (clientId) {
        await pool.query(
          `UPDATE clients SET subscription_status='cancelled' WHERE id=$1`,
          [clientId]
        );
        console.log(`[stripe] client ${clientId} → cancelled`);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[stripe] webhook handler error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Existing content-subscriptions routes (unchanged) ─────────

// GET /api/subscriptions?clientId=X  — load all for a client
router.get('/', requireAuth, async (req, res) => {
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
router.post('/', requireAuth, async (req, res) => {
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
router.get('/due', requireAuth, async (req, res) => {
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
router.post('/mark-sent', requireAuth, async (req, res) => {
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
