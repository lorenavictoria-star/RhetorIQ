// Notfallkarte in der Plattform: Inhalt als JSON für die Seite, dazu Word zum Ausdrucken. Nur Beraterin.
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const nd = require('../lib/notfalldokumente');

const router = express.Router();

router.get('/', requireAdvisor, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(nd.KARTE);
});

router.get('/notfallkarte.docx', requireAdvisor, async (req, res) => {
  try {
    const buf = await nd.buildNotfallkarte();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': 'attachment; filename="RhetorIQ_Notfallkarte.docx"', 'Cache-Control': 'no-store'
    });
    res.send(buf);
  } catch (e) {
    console.error('[notfallkarte]', e.message);
    res.status(500).json({ error: 'Die Notfallkarte konnte nicht erstellt werden.' });
  }
});

module.exports = router;
