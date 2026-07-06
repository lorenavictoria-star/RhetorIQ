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
  await pool.query(
    `INSERT INTO client_module_prompts (client_id, module_key, instructions, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (client_id, module_key) DO UPDATE SET instructions=$3, updated_at=NOW()`,
    [clientId, moduleKey, instructions]
  );
  res.json({ ok: true });
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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
