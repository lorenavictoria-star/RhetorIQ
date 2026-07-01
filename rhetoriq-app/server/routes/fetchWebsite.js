const express = require('express');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// POST /api/fetch-website
router.post('/', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RhetorIQ/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.status(400).json({ error: `Website returned ${r.status}` });

    const html = await r.text();

    // Strip HTML tags, scripts, styles — keep readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 8000); // cap at 8000 chars

    res.json({ text, chars: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not fetch website' });
  }
});

module.exports = router;
