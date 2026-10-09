const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const q = require('../lib/quartalsreview');

const router = express.Router();

// GET /api/quartalsreview/due  (Business-Klienten, ob der Review dieses Quartals noch offen ist)
router.get('/due', requireAdvisor, async (req, res) => {
  try { res.json(await q.dueList(req.user.id)); }
  catch (e) { console.error('[quartalsreview]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/quartalsreview/:clientId/vorlage.docx?quartal=2026-Q4
router.get('/:clientId/vorlage.docx', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const quartal = q.validQuartal(req.query.quartal) ? req.query.quartal : q.quartalOf();
    const r = await q.buildVorlage(Number(req.params.clientId), quartal);
    const safe = String(r.name).replace(/[^A-Za-z0-9ÄÖÜäöüéèàç _-]/g, '').trim().replace(/\s+/g, '_') || 'Klient';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Quartalsreview_${encodeURIComponent(safe)}_${r.quartal}.docx"`
    });
    res.send(r.buffer);
  } catch (e) { console.error('[quartalsreview]', e.message); res.status(400).json({ error: e.message }); }
});

// GET /api/quartalsreview/:clientId/:quartal  (Status, Termin, Notizen)
router.get('/:clientId/:quartal', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    if (!q.validQuartal(req.params.quartal)) return res.status(400).json({ error: 'Ungültiges Quartal.' });
    const r = await q.getOne(Number(req.params.clientId), req.params.quartal);
    res.json(r || { client_id: Number(req.params.clientId), quartal: req.params.quartal, status: 'offen', termin: '', notizen: '' });
  } catch (e) { console.error('[quartalsreview]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/quartalsreview/:clientId/:quartal  { termin, notizen, status }
router.put('/:clientId/:quartal', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const { termin, notizen, status } = req.body || {};
    res.json(await q.save(Number(req.params.clientId), req.params.quartal, { termin, notizen, status }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
