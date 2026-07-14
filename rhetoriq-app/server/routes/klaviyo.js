const express = require('express');
const router = express.Router();
const { requireAdvisor } = require('../middleware/auth');

// POST /api/klaviyo/templates — fetch existing templates from Klaviyo
// (POST + body, not GET + query string, so the API key never lands in a URL
// or server access log)
router.post('/templates', requireAdvisor, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  try {
    // Klaviyo caps page[size] at 10 for this endpoint. Follow the cursor-based
    // "next" link to collect more, up to a sane cap so this can't run away.
    let url = 'https://a.klaviyo.com/api/templates/?page[size]=10';
    let templates = [];
    for (let page = 0; page < 5 && url; page++) {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Klaviyo-API-Key ${apiKey}`,
          'revision': '2024-02-15',
          'Accept': 'application/json'
        }
      });
      const d = await r.json();
      if (!r.ok) {
        const msg = d?.errors?.[0]?.detail || d?.errors?.[0]?.title || 'Klaviyo error';
        return res.status(400).json({ error: msg });
      }
      templates = templates.concat((d.data || []).map(t => ({
        id: t.id,
        name: t.attributes?.name || 'Untitled',
        html: t.attributes?.html || '',
        created: t.attributes?.created
      })));
      url = d.links?.next || null;
    }
    res.json({ templates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/klaviyo/draft — create email template in Klaviyo
router.post('/draft', requireAdvisor, async (req, res) => {
  const { apiKey, subject, content } = req.body;
  if (!apiKey || !content) return res.status(400).json({ error: 'apiKey and content required' });

  const name = `${subject || 'RhetorIQ Draft'} — ${new Date().toLocaleDateString('de-CH')}`;
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#1a1a1a;line-height:1.7">${content.replace(/\n/g, '<br>')}</body></html>`;

  try {
    const r = await fetch('https://a.klaviyo.com/api/templates/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${apiKey}`,
        'revision': '2024-02-15',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        data: {
          type: 'template',
          attributes: { name, html, editor_type: 'CODE' }
        }
      })
    });
    const d = await r.json();
    if (!r.ok) {
      const msg = d?.errors?.[0]?.detail || d?.errors?.[0]?.title || 'Klaviyo error';
      return res.status(400).json({ error: msg });
    }
    res.json({ ok: true, templateId: d.data?.id, templateName: name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
