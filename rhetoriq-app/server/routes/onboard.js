const express = require('express');
const multer = require('multer');
const https = require('https');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { generateText, resolveModelId } = require('../lib/aiProvider');
const { allowedClientId } = require('../middleware/ownership');
const { TEMPERATUR } = require('../lib/temperaturen');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
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
  const r = await generateText({
    system, messages: [{ role: 'user', content: user }], maxTokens: 400,
    // Dateisortierung ist eine einfache Zuordnung (Kategorie, Kurzfassung): das günstige Modell genügt
    model: resolveModelId('haiku'), temperature: TEMPERATUR.analyse, meter: { module: 'onboard' }
  });
  return r.text || '';
}

async function categorize(filename, text) {
  const snippet = text.slice(0, 3000);
  const system = `You are categorizing documents for a leadership communication coaching platform called RhetorIQ.
Respond ONLY with valid JSON — no explanation, no markdown.

Categories:
${Object.entries(CATEGORIES).map(([k,v]) => `- ${k}: ${v}`).join('\n')}

Also decide whether the document is a finished sample text (a complete speech, post, email, newsletter, press release or web text that could serve as a writing example). If yes, set "sampleTile" to one of: speech, linkedin, email, newsletter, press, website, brief, custom. Otherwise null.

Return: {"category":"<one of the category keys>","personName":"<only if people_voice, else null>","summary":"<one sentence describing what this document is>","sampleTile":"<tile or null>","confidence":<0.0-1.0>}`;

  const raw = await callClaude(system, `Filename: ${filename}\n\nContent (excerpt):\n${snippet}`);
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    return JSON.parse(json);
  } catch {
    return { category: 'skip', personName: null, summary: 'Could not categorize', confidence: 0 };
  }
}

// Vorschlag, welchem Modul ein fertiger Mustertext als Beispiel dient. Wird als Vorschlag (status proposed) abgelegt und
// fliesst erst in die Auswahl ein, wenn die Beraterin ihn bestätigt (POST /api/module-examples/:id/confirm).
const TILE_AUS_KATEGORIE = { ref_speech: 'speech', ref_linkedin: 'linkedin', ref_email: 'email', ref_newsletter: 'newsletter', ref_press: 'press', ref_website: 'website' };
const TILES = ['speech', 'linkedin', 'email', 'newsletter', 'press', 'website', 'brief', 'custom'];
async function schlageBeispielVor({ clientId, advisorId, filename, summary, category, sampleTile, text }) {
  const tile = TILES.includes(sampleTile) ? sampleTile : (TILE_AUS_KATEGORIE[category] || null);
  const body = String(text || '').trim().slice(0, 12000);
  if (!tile || !advisorId || body.length < 200) return null;
  const { rows: dup } = await pool.query(
    'SELECT id FROM module_examples WHERE advisor_id=$1 AND source_client_id=$2 AND output_text=$3', [advisorId, clientId, body]);
  if (dup[0]) return null;
  const { rows } = await pool.query(
    `INSERT INTO module_examples (advisor_id, module_key, tile, label, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable, origin, status)
     VALUES ($1,'text-gen',$2,$3,$4,$5,3,false,$6,false,'onboarding','proposed') RETURNING id`,
    [advisorId, tile, String(filename || '').slice(0, 120) || null, String(summary || filename || 'Mustertext').slice(0, 300), body, clientId]);
  return { id: rows[0].id, module_key: 'text-gen', tile };
}

async function saveToMemory(clientId, advisorId, type, content) {
  await pool.query(
    `INSERT INTO company_memory (client_id, memory_type, content)
     VALUES ($1,$2,$3)
     ON CONFLICT (client_id, memory_type)
     DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, type, content]
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
router.post('/', requireAuth, requireRole('editor'), upload.array('files', 5), async (req, res) => {
  const clientId = await allowedClientId(req, req.body.clientId);
  if (!clientId) return res.status(req.body.clientId ? 403 : 400).json({ error: req.body.clientId ? 'Kein Zugriff auf diesen Klienten.' : 'clientId required' });
  const advisorId = req.user.role === 'advisor' ? req.user.id : req.user.advisorId;

  const brandVoiceSources = [];

  async function processFile(file) {
    const result = { filename: file.originalname, status: 'processing', category: null, summary: null, saved: null };
    try {
      let text = '';
      const name = file.originalname.toLowerCase();
      if (name.endsWith('.txt')) {
        text = file.buffer.toString('utf-8');
      } else if (name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc')) {
        text = file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\tÀ-ɏЀ-ӿ]/g, ' ');
      } else {
        text = file.buffer.toString('utf-8');
      }

      if (!text.trim()) {
        result.status = 'skipped';
        result.summary = 'Empty or unreadable file';
        return result;
      }

      const cat = await categorize(file.originalname, text);
      result.category = cat.category;
      result.summary = cat.summary;
      result.personName = cat.personName;
      try {
        const v = await schlageBeispielVor({ clientId, advisorId, filename: file.originalname, summary: cat.summary, category: cat.category, sampleTile: cat.sampleTile, text });
        if (v) result.exampleProposal = v;
      } catch (e) { console.error('[onboard] Beispielvorschlag:', e.message); }

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
    return result;
  }

  const results = await Promise.all(req.files.map(processFile));

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
module.exports.schlageBeispielVor = schlageBeispielVor;
