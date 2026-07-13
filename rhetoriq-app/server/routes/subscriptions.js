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
      if (clientId) {
        await pool.query(
          `UPDATE clients SET subscription_status='active' WHERE id=$1`,
          [clientId]
        );
        console.log(`[stripe] client ${clientId} → active (${event.type})`);
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
