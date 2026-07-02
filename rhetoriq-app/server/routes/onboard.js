const express = require('express');
const multer = require('multer');
const https = require('https');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const router = express.Router();

const CATEGORIES = {
  brand_voice_source: 'Raw communication texts (emails, speeches, posts, reports) — used to generate Brand Voice',
  brand_voice_analysis: 'An already completed Brand Voice analysis or voice profile description',
  ref_speech: 'Speech or presentation examples — reference for Speech module',
  ref_linkedin: 'LinkedIn posts or social media content — reference for LinkedIn module',
  ref_email: 'Email examples — reference for Email module',
  ref_newsletter: 'Newsletter content — reference for Newsletter module',
  ref_press: 'Press releases — reference for Press Release module',
  ref_website: 'Website copy — reference for Website module',
  key_facts: 'Background info, company facts, bios, strategy documents, culture notes',
  people_voice: 'Texts clearly written by one specific named person — used to create their Voice DNA',
  skip: 'File cannot be used or has no clear relevance'
};

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
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

async function categorize(filename, text) {
  const snippet = text.slice(0, 3000);
  const system = `You are categorizing documents for a leadership communication coaching platform called RhetorIQ.
Respond ONLY with valid JSON — no explanation, no markdown.

Categories:
${Object.entries(CATEGORIES).map(([k,v]) => `- ${k}: ${v}`).join('\n')}

Return: {"category":"<one of the category keys>","personName":"<only if people_voice, else null>","summary":"<one sentence describing what this document is>","confidence":<0.0-1.0>}`;

  const raw = await callClaude(system, `Filename: ${filename}\n\nContent (excerpt):\n${snippet}`);
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    return JSON.parse(json);
  } catch {
    return { category: 'skip', personName: null, summary: 'Could not categorize', confidence: 0 };
  }
}

async function saveToMemory(clientId, advisorId, type, content) {
  await pool.query(
    `INSERT INTO company_memory (client_id, advisor_id, memory_type, content)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_id, memory_type)
     DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, advisorId, type, content]
  );
}

async function appendToMemory(clientId, advisorId, type, content) {
  const { rows } = await pool.query(
    'SELECT content FROM company_memory WHERE client_id=$1 AND memory_type=$2',
    [clientId, type]
  );
  const existing = rows[0]?.content || '';
  const merged = existing ? existing + '\n\n---\n\n' + content : content;
  await saveToMemory(clientId, advisorId, type, merged);
}

// POST /api/onboard — accepts multipart files + clientId
router.post('/', requireAuth, upload.array('files', 30), async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;

  const results = [];
  const brandVoiceSources = [];

  for (const file of req.files) {
    const result = { filename: file.originalname, status: 'processing', category: null, summary: null, saved: null };
    try {
      // Extract text from buffer (UTF-8 for txt, raw for others we'll try)
      let text = '';
      const name = file.originalname.toLowerCase();
      if (name.endsWith('.txt')) {
        text = file.buffer.toString('utf-8');
      } else if (name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc')) {
        // We'll send the text extraction signal to frontend — these are handled client-side
        // but if they arrive here as text/plain fallback, use buffer
        text = file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\tÀ-ɏЀ-ӿ]/g, ' ');
      } else {
        text = file.buffer.toString('utf-8');
      }

      if (!text.trim()) {
        result.status = 'skipped';
        result.summary = 'Empty or unreadable file';
        results.push(result);
        continue;
      }

      const cat = await categorize(file.originalname, text);
      result.category = cat.category;
      result.summary = cat.summary;
      result.personName = cat.personName;

      if (cat.category === 'brand_voice_source') {
        brandVoiceSources.push(text);
        result.saved = 'Collected for Brand Voice generation';
        result.status = 'done';
      } else if (cat.category === 'brand_voice_analysis') {
        await saveToMemory(clientId, advisorId, 'brand_voice', text);
        result.saved = 'Saved to Memory → Brand Voice';
        result.status = 'done';
      } else if (cat.category === 'key_facts') {
        await appendToMemory(clientId, advisorId, 'key_facts', text);
        result.saved = 'Saved to Memory → Key Facts';
        result.status = 'done';
      } else if (cat.category.startsWith('ref_')) {
        const tgKey = 'ref_tg_' + cat.category.replace('ref_', '');
        await appendToMemory(clientId, advisorId, tgKey, text);
        result.saved = `Saved as reference → ${cat.category.replace('ref_', '').charAt(0).toUpperCase() + cat.category.replace('ref_', '').slice(1)} module`;
        result.status = 'done';
      } else if (cat.category === 'people_voice') {
        result.saved = cat.personName
          ? `Ready for Voice DNA — person: ${cat.personName}`
          : 'Ready for Voice DNA — assign to a person in the People module';
        result.text = text;
        result.status = 'done';
      } else {
        result.status = 'skipped';
        result.saved = 'Not categorized';
      }
    } catch (e) {
      result.status = 'error';
      result.summary = e.message;
    }
    results.push(result);
  }

  // If brand voice sources collected, save them as raw ref for advisor to trigger manually
  if (brandVoiceSources.length) {
    try {
      const combined = brandVoiceSources.join('\n\n---\n\n');
      await appendToMemory(clientId, advisorId, 'ref_brand_voice_source', combined);
    } catch {}
  }

  res.json({ results, brandVoiceSourceCount: brandVoiceSources.length });
});

module.exports = router;
