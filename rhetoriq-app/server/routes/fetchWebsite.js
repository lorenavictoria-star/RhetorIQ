const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { safeFetchHtml, htmlToText } = require('../lib/safeFetch');
const router = express.Router();

// POST /api/fetch-website (Schutz gegen Abrufe interner Adressen über lib/safeFetch)
router.post('/', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const page = await safeFetchHtml(url);
    const text = htmlToText(page.html, 8000);
    res.json({ text, chars: text.length });
  } catch (e) {
    console.error('[fetch-website]', e.message);
    res.status(400).json({ error: 'Webseite konnte nicht abgerufen werden.' });
  }
});

module.exports = router;
