// Gesamtexport der Daten (ZIP mit JSON je Tabelle). Nur Beraterin.
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');

const router = express.Router();

router.get('/export.zip', requireAdvisor, async (req, res) => {
  try {
    const { buffer } = await require('../lib/backupExport').buildExportZip(req.user.id);
    res.set({
      'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="RhetorIQ_Gesamtexport_${new Date().toISOString().slice(0, 10)}.zip"`
    });
    res.send(buffer);
  } catch (e) {
    console.error('[backup] Export:', e.message);
    res.status(500).json({ error: 'Der Gesamtexport hat nicht geklappt.' });
  }
});

module.exports = router;
