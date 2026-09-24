const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { generateText, resolveModelId } = require('../lib/aiProvider');

const router = express.Router();

// GET/PUT /api/advisor/sender-address — advisor's own company address, used to
// auto-fill the "Sender (Absender)" field on the Brief / formal-letter module.
let senderAddressColumnEnsured = false;
async function ensureSenderAddressColumn() {
  if (senderAddressColumnEnsured) return;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sender_address TEXT`);
  senderAddressColumnEnsured = true;
}

router.get('/sender-address', requireAdvisor, async (req, res) => {
  try {
    await ensureSenderAddressColumn();
    const { rows } = await pool.query('SELECT sender_address FROM users WHERE id=$1', [req.user.id]);
    res.json({ senderAddress: rows[0]?.sender_address || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/sender-address', requireAdvisor, async (req, res) => {
  try {
    await ensureSenderAddressColumn();
    const { senderAddress } = req.body;
    await pool.query('UPDATE users SET sender_address=$1 WHERE id=$2', [senderAddress || '', req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/dashboard
router.get('/dashboard', requireAdvisor, async (req, res) => {
  try {
    const advisorId = req.user.id;

    const [clientsRes, statsRes, recentRes] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.industry, c.created_at,
          COUNT(a.id) AS total_analyses,
          MAX(a.created_at) AS last_activity,
          COUNT(CASE WHEN a.created_at > NOW() - INTERVAL '7 days' THEN 1 END) AS analyses_7d
         FROM clients c
         LEFT JOIN analyses a ON a.client_id = c.id AND a.advisor_id = $1
         WHERE c.advisor_id = $1
         GROUP BY c.id ORDER BY last_activity DESC NULLS LAST`,
        [advisorId]
      ),
      pool.query(
        `SELECT
          COUNT(DISTINCT c.id) AS total_clients,
          COUNT(a.id) FILTER (WHERE a.created_at > NOW() - INTERVAL '30 days') AS analyses_30d,
          COUNT(DISTINCT a.client_id) FILTER (WHERE a.created_at > NOW() - INTERVAL '7 days') AS active_clients_7d
         FROM clients c
         LEFT JOIN analyses a ON a.client_id = c.id AND a.advisor_id = $1
         WHERE c.advisor_id = $1`,
        [advisorId]
      ),
      pool.query(
        `SELECT a.id, a.module, a.module_label, a.created_at, c.name AS client_name
         FROM analyses a
         JOIN clients c ON c.id = a.client_id
         WHERE a.advisor_id = $1
         ORDER BY a.created_at DESC LIMIT 20`,
        [advisorId]
      )
    ]);

    res.json({
      stats: statsRes.rows[0],
      clients: clientsRes.rows,
      recent: recentRes.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/timeline/:clientId
router.get('/timeline/:clientId', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, module, module_label, created_at
       FROM analyses
       WHERE client_id = $1 AND advisor_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.clientId, req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/costs — token costs per client (last 30 days)
// Pricing: claude-sonnet-4-6 = $3/MTok input, $15/MTok output
const PRICE_INPUT  = 3  / 1_000_000; // USD per token
const PRICE_OUTPUT = 15 / 1_000_000;

router.get('/costs', requireAdvisor, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    if (days < 1 || days > 365) return res.status(400).json({ error: 'days must be 1–365' });

    const { rows } = await pool.query(`
      SELECT
        COALESCE(c.name, 'Ohne Klient') AS client_name,
        ul.client_id,
        COUNT(*)::int                          AS calls,
        SUM(ul.input_tokens)::bigint           AS input_tokens,
        SUM(ul.output_tokens)::bigint          AS output_tokens,
        ROUND(
          (SUM(ul.input_tokens) * $2 + SUM(ul.output_tokens) * $3)::numeric, 4
        )                                      AS cost_usd
      FROM usage_log ul
      LEFT JOIN clients c ON c.id = ul.client_id
      WHERE ul.advisor_id = $1
        AND ul.created_at > NOW() - ($4 || ' days')::interval
      GROUP BY ul.client_id, c.name
      ORDER BY cost_usd DESC
    `, [req.user.id, PRICE_INPUT, PRICE_OUTPUT, days]);

    const total = rows.reduce((sum, r) => sum + parseFloat(r.cost_usd || 0), 0);

    res.json({ days, rows, total_usd: total.toFixed(4) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/advisor/workspace/:clientId — the consolidated per-client
// "workspace": everything the advisor previously had to gather from separate
// corners of the app (client meta/plan, Brand Voice, module-prompt overrides)
// in one call. Pending review requests and feedback learnings are fetched by
// the frontend from their existing dedicated endpoints (/api/reviews,
// /api/audit/:clientId/feedback-*) and merged into this same workspace view,
// rather than duplicated here.
router.get('/workspace/:clientId', requireAdvisor, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid client ID' });

    const { rows: cRows } = await pool.query(
      `SELECT id, name, industry, contact, slug, token, subscription_status,
              monthly_token_limit, client_type, created_at
       FROM clients WHERE id=$1 AND advisor_id=$2`,
      [clientId, req.user.id]
    );
    if (!cRows[0]) return res.status(404).json({ error: 'Client not found' });

    const [{ rows: brandVoice }, { rows: modulePrompts }] = await Promise.all([
      pool.query(
        `SELECT memory_type, content, updated_at FROM company_memory
         WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY updated_at DESC`,
        [clientId]
      ),
      pool.query(
        `SELECT module_key, instructions, updated_at FROM client_module_prompts
         WHERE client_id=$1 ORDER BY module_key`,
        [clientId]
      )
    ]);

    res.json({ client: cRows[0], brandVoice, modulePrompts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/advisor/workspace/:clientId/chat — the persistent KI-Assistent
// docked in the Workspace, visible across every tab. Always has this
// client's Brand Voice, module-prompt overrides, and feedback learnings as
// context. When editing a Freigabe (review), the frontend also sends the
// review's current text; if the advisor asks for a rewrite, the model wraps
// the full revised text between REVISED_MARKER_START/END so the frontend can
// offer a one-click "Ins Textfeld übernehmen" instead of manual copy/paste.
const REVISED_START = '---REVISED TEXT START---';
const REVISED_END = '---REVISED TEXT END---';

router.post('/workspace/:clientId/chat', requireAdvisor, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid client ID' });
    const { message, history, activeReviewText } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    const { rows: cRows } = await pool.query(
      'SELECT id, name, industry FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!cRows[0]) return res.status(404).json({ error: 'Client not found' });
    const client = cRows[0];

    const [{ rows: brandVoice }, { rows: modulePrompts }, { rows: learnings }] = await Promise.all([
      pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY updated_at DESC`, [clientId]),
      pool.query('SELECT module_key, instructions FROM client_module_prompts WHERE client_id=$1', [clientId]),
      pool.query('SELECT module_key, category, summary FROM client_feedback_learnings WHERE client_id=$1', [clientId])
    ]);

    const contextParts = [
      `Klient: ${client.name}${client.industry ? ' (Branche: ' + client.industry + ')' : ''}`,
      brandVoice.length ? 'Brand Voice:\n' + brandVoice.map(b => b.content).join('\n\n').slice(0, 3000) : null,
      modulePrompts.length ? 'Individuelle Modul-Vorgaben:\n' + modulePrompts.map(p => `[${p.module_key}] ${p.instructions}`).join('\n') : null,
      learnings.length ? 'Bekannte Feedback-Lernstände:\n' + learnings.map(l => `[${l.module_key}/${l.category}] ${l.summary}`).join('\n') : null
    ].filter(Boolean).join('\n\n');

    const systemPrompt = `Du bist die persönliche KI-Assistentin der Beraterin (nicht des Kunden) für die Bearbeitung von Texten und Fragen rund um diesen einen Klienten. Du kennst dessen Brand Voice, individuelle Modul-Vorgaben und bisherige Feedback-Lernstände (unten).

Wenn die Beraterin einen konkreten Text überarbeitet haben möchte (z.B. während sie eine Freigabe-Anfrage bearbeitet und dir den aktuellen Text mitgegeben hat), gib die VOLLSTÄNDIGE überarbeitete Fassung zurück, exakt eingerahmt zwischen den Zeilen "${REVISED_START}" und "${REVISED_END}", gefolgt von maximal 1-2 kurzen Sätzen was du geändert hast. Bei allgemeinen Fragen oder Ratschlägen antworte normal, ohne diese Marker.

KONTEXT ZU DIESEM KLIENTEN:
${contextParts}`;

    const messages = [];
    (Array.isArray(history) ? history : []).slice(-10).forEach(h => {
      if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.text });
    });
    const userContent = activeReviewText
      ? `AKTUELLER TEXT, DER GERADE BEARBEITET WIRD:\n${activeReviewText}\n\n---\n\nAnweisung der Beraterin: ${message.trim()}`
      : message.trim();
    messages.push({ role: 'user', content: userContent });

    const resp = await generateText({
      system: systemPrompt,
      messages,
      maxTokens: 3000,
      model: resolveModelId('sonnet'),
      temperature: 0.5
    });

    let reply = resp.text || '';
    let revisedText = null;
    const startIdx = reply.indexOf(REVISED_START);
    const endIdx = reply.indexOf(REVISED_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      revisedText = reply.slice(startIdx + REVISED_START.length, endIdx).trim();
      reply = (reply.slice(0, startIdx) + reply.slice(endIdx + REVISED_END.length)).trim();
      if (!reply) reply = 'Überarbeitete Fassung erstellt.';
    }

    res.json({ reply, revisedText });
  } catch (e) {
    console.error('[advisor] workspace chat failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
