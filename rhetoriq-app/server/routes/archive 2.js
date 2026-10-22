const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const archive = require('../lib/archive');

const router = express.Router();

// Beraterin für ihre Klienten, Klient nur der Hauptzugang und die Rolle admin
function adminOnly(req, res, next) {
  const u = req.user;
  if (u.role === 'client' && u.clientUserId && u.clientUserRole !== 'admin') {
    return res.status(403).json({ error: 'Das Reden-Archiv ist für die Rolle Admin und den Hauptzugang vorgesehen.' });
  }
  next();
}

// GET /api/archive/:clientId/reden?year=2026
router.get('/:clientId/reden', requireAuth, ownClient('clientId'), adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.clientId);
    const r = await archive.listReden(id, req.query.year);
    res.json({
      year: r.year, years: await archive.listYears(id),
      reden: r.reden.map(({ id, date, title, words }) => ({ id, date, title, words }))
    });
  } catch (e) { console.error('[archive]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/archive/:clientId/rueckblick.docx?year=2026
router.get('/:clientId/rueckblick.docx', requireAuth, ownClient('clientId'), adminOnly, async (req, res) => {
  try {
    const r = await archive.buildRueckblick(Number(req.params.clientId), req.query.year);
    const safe = String(r.name).replace(/[^A-Za-z0-9ÄÖÜäöüéèàç _-]/g, '').trim().replace(/\s+/g, '_') || 'Klient';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Reden-Archiv_${encodeURIComponent(safe)}_${r.year}.docx"`
    });
    res.send(r.buffer);
  } catch (e) { console.error('[archive]', e.message); res.status(400).json({ error: e.message }); }
});

module.exports = router;
