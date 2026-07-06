const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_modules (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      advisor_id INTEGER,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      system_prompt TEXT NOT NULL,
      input_fields JSONB DEFAULT '[]',
      icon VARCHAR(10) DEFAULT '◆',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureTable().catch(console.error);

async function callClaude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

// POST /api/custom-modules/generate — advisor only, generates module suggestions from discovery notes
router.post('/generate', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
  const { notes, clientName, language } = req.body;
  if (!notes) return res.status(400).json({ error: 'notes required' });

  const lang = language === 'de' ? 'German' : 'English';

  const system = `You are a communication workflow designer for RhetorIQ, an AI-powered communication coaching platform for advisors working with executive clients.

Based on the advisor's discovery notes about a client, generate 4–6 custom AI module definitions tailored to that client's specific communication needs.

Each module must be a standalone AI tool that the advisor can run for text analysis, generation, or coaching tasks.

Respond ONLY with valid JSON array. No markdown, no explanation.

Format:
[
  {
    "name": "Short module name (max 30 chars)",
    "description": "One sentence describing what this module does for the user.",
    "icon": "single emoji that fits the module",
    "input_fields": [
      {"id": "field_id", "label": "Field label", "type": "text|textarea|select", "placeholder": "example placeholder", "options": ["only if type=select"]}
    ],
    "system_prompt": "Full system prompt for Claude. Use {field_id} placeholders matching the input_fields ids. Be specific and detailed. Instruct Claude to output plain text (no markdown). Output in ${lang}."
  }
]

Rules:
- input_fields should be 1–4 fields, practical and minimal
- system_prompt must reference at least one {field_id} placeholder
- Modules should be diverse — mix generation, analysis, and coaching tasks
- Tailor everything to the client's industry, size, and communication needs
- All names and descriptions in ${lang}`;

  try {
    const raw = await callClaude(system, `Client: ${clientName || 'Unknown'}\n\nDiscovery notes:\n${notes}`);
    const json = raw.match(/\[[\s\S]*\]/)?.[0];
    const modules = JSON.parse(json);
    res.json({ modules });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/custom-modules?clientId=X
router.get('/', requireAuth, async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM custom_modules WHERE client_id=$1 ORDER BY created_at',
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/custom-modules — save a module
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
  const { client_id, name, description, system_prompt, input_fields, icon } = req.body;
  if (!client_id || !name || !system_prompt) return res.status(400).json({ error: 'client_id, name, system_prompt required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO custom_modules (client_id, advisor_id, name, description, system_prompt, input_fields, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [client_id, req.user.id, name, description || '', system_prompt, JSON.stringify(input_fields || []), icon || '◆']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/custom-modules/:id — update
router.put('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
  const { name, description, system_prompt, input_fields, icon } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE custom_modules SET name=$1,description=$2,system_prompt=$3,input_fields=$4,icon=$5
       WHERE id=$6 AND advisor_id=$7 RETURNING *`,
      [name, description, system_prompt, JSON.stringify(input_fields || []), icon || '◆', req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/custom-modules/:id
router.delete('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
  try {
    await pool.query('DELETE FROM custom_modules WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/custom-modules/:id/run — run a custom module
router.post('/:id/run', requireAuth, async (req, res) => {
  const { inputs, clientId } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM custom_modules WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Module not found' });
    const mod = rows[0];

    // Build user message by substituting {field_id} placeholders
    let userMsg = '';
    (mod.input_fields || []).forEach(f => {
      const val = (inputs || {})[f.id] || '';
      userMsg += `${f.label}:\n${val}\n\n`;
    });

    // Also substitute in system prompt
    let systemPrompt = mod.system_prompt;
    (mod.input_fields || []).forEach(f => {
      const val = (inputs || {})[f.id] || '';
      systemPrompt = systemPrompt.replace(new RegExp(`\\{${f.id}\\}`, 'g'), val);
    });

    // Log to analyses table if it exists
    try {
      const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;
      await pool.query(
        `INSERT INTO analyses (advisor_id, client_id, module, input_text, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [advisorId, clientId || null, 'custom:' + mod.name, userMsg.slice(0, 500)]
      );
    } catch {}

    const result = await callClaude(systemPrompt, userMsg || 'Please proceed.');
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
