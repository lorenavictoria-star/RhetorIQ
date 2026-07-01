const express = require('express');
const router = express.Router();
const { requireAdvisor } = require('../middleware/auth');

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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
