const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/module-prompts/:clientId/:moduleKey
router.get('/:clientId/:moduleKey', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, moduleKey } = req.params;
  const { rows } = await pool.query(
    'SELECT instructions FROM client_module_prompts WHERE client_id=$1 AND module_key=$2',
    [clientId, moduleKey]
  );
  res.json({ instructions: rows[0]?.instructions || '' });
});

// POST /api/module-prompts/:clientId/:moduleKey
router.post('/:clientId/:moduleKey', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, moduleKey } = req.params;
  const { instructions } = req.body;
  if (instructions && instructions.length > 4000) return res.status(400).json({ error: 'Instructions max 4000 characters' });
  await pool.query(
    `INSERT INTO client_module_prompts (client_id, module_key, instructions, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (client_id, module_key) DO UPDATE SET instructions=$3, updated_at=NOW()`,
    [clientId, moduleKey, instructions]
  );
  res.json({ ok: true });
});

// POST /api/module-prompts/suggest — generate a prompt suggestion for one module+client
router.post('/suggest', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, moduleKey, moduleLabel } = req.body;
  if (!clientId || !moduleKey) return res.status(400).json({ error: 'Missing params' });

  // Fetch brand voice
  const { rows: memRows } = await pool.query(
    `SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY updated_at DESC`,
    [clientId]
  );
  const brandVoice = memRows.map(m => m.content).join('\n\n');

  // Fetch client industry
  const { rows: cRows } = await pool.query('SELECT name, industry FROM clients WHERE id=$1', [clientId]);
  const client = cRows[0];

  // Fetch top manual training examples for this module
  const advisorId = req.user.id;
  const industry = client?.industry?.toLowerCase().trim() || null;
  const { rows: examples } = await pool.query(
    `SELECT input_text, output_text FROM module_examples
     WHERE advisor_id=$1 AND module_key=$2 AND auto_generated=false
     ORDER BY rating DESC, created_at DESC LIMIT 2`,
    [advisorId, moduleKey]
  );

  if (!brandVoice && !examples.length) {
    return res.json({ suggestion: '' });
  }

  const examplesText = examples.length
    ? '\n\nReferenz-Outputs (Beispiele aus der Praxis):\n' +
      examples.map((e, i) => `Beispiel ${i + 1}:\n${e.output_text.substring(0, 400)}`).join('\n\n')
    : '';

  const prompt = `Du bist ein KI-Prompt-Experte. Schreibe eine präzise, konkrete Anweisung (3-5 Sätze) für das Modul "${moduleLabel || moduleKey}" bei diesem Kunden.

Klient: ${client?.name || ''}${client?.industry ? ' (Branche: ' + client.industry + ')' : ''}

Brand Voice des Klienten:
${brandVoice.substring(0, 2000)}${examplesText}

Schreibe eine Anweisung, die:
- Konkret auf die Tonalität und Sprache dieser Brand Voice eingeht
- Dem Modul "${moduleLabel || moduleKey}" spezifische Vorgaben gibt (Format, Länge, Struktur, Stil)
- Verhindert, dass der Output nach generischer KI klingt

Nur die Anweisung selbst, kein Intro, kein Outro. Auf Deutsch.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ suggestion: data.content?.[0]?.text?.trim() || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/module-prompts/generate-starters
router.post('/generate-starters', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, brandVoice, type } = req.body;
  if (!clientId || !brandVoice) return res.status(400).json({ error: 'Missing clientId or brandVoice' });

  const modules = [
    { key: 'text-gen-linkedin', label: 'LinkedIn posts' },
    { key: 'text-gen-newsletter', label: 'newsletters' },
    { key: 'text-gen-email', label: 'emails' },
    { key: 'text-gen-speech', label: 'speeches' },
    { key: 'text-gen-press', label: 'press releases' },
    { key: 'text-gen-website', label: 'website copy' },
    { key: 'text-gen-custom', label: 'custom formats (proposals, announcements)' },
    { key: 'profiling', label: 'rhetoric profiling analysis' },
    { key: 'risk', label: 'communication risk scan' },
    { key: 'pre-meeting', label: 'pre-meeting briefs' },
    { key: 'review', label: 'performance reviews / feedback' },
    { key: 'before-after', label: 'text improvement' },
  ];

  const prompt = `Based on this ${type === 'individual' ? 'individual' : 'company'} Brand Voice profile, write a short custom instruction (2-4 sentences max) for each module below. Each instruction tells the AI how to apply this specific brand voice when running that module. Be concrete and specific to the voice — not generic.

Brand Voice Profile:
${brandVoice.substring(0, 3000)}

Write instructions for these modules (respond as JSON array with "key" and "instructions" fields):
${modules.map(m => `- ${m.key}: ${m.label}`).join('\n')}

Return ONLY valid JSON array, no other text.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    let results;
    try {
      const text = data.content?.[0]?.text || '[]';
      results = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    for (const item of results) {
      if (!item.key || !item.instructions) continue;
      await pool.query(
        `INSERT INTO client_module_prompts (client_id, module_key, instructions, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (client_id, module_key) DO UPDATE SET instructions=$3, updated_at=NOW()`,
        [clientId, item.key, item.instructions]
      );
    }

    res.json({ ok: true, count: results.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
