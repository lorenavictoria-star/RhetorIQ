const express = require('express');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const cp = require('../lib/commProfile');

const router = express.Router();

// GET /api/comm-profile/:clientId  (Beraterin und der Klient selbst, nur lesen)
router.get('/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try { res.json(await cp.getProfile(Number(req.params.clientId))); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/comm-profile/:clientId/report.docx  (Stimmprofil als Word, nur Beraterin)
router.get('/:clientId/report.docx', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const r = await require('../lib/stimmReport').buildReport(Number(req.params.clientId));
    const safe = String(r.name).replace(/[^A-Za-z0-9ÄÖÜäöüéèàç _-]/g, '').trim().replace(/\s+/g, '_') || 'Klient';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Stimmprofil_${encodeURIComponent(safe)}.docx"`
    });
    res.send(r.buffer);
  } catch (e) { console.error('[stimm-report]', e.message); res.status(400).json({ error: e.message }); }
});

// POST /api/comm-profile/:clientId/baseline  { texts: "Text 1\n---\nText 2" } oder [..]
router.post('/:clientId/baseline', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const raw = req.body.texts;
    const texts = Array.isArray(raw) ? raw : String(raw || '').split(/\n\s*---+\s*\n/);
    await cp.createBaseline(Number(req.params.clientId), texts);
    res.json(await cp.getProfile(Number(req.params.clientId)));
  } catch (e) {
    console.error('[comm-profile]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /api/comm-profile/:clientId/snapshot  (Messung jetzt)
router.post('/:clientId/snapshot', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const r = await cp.snapshotClient(Number(req.params.clientId), { minTexts: 1 });
    if (r.skipped) return res.status(400).json({ error: 'Seit der letzten Messung gibt es keine neuen verwendeten Texte.' });
    res.json(await cp.getProfile(Number(req.params.clientId)));
  } catch (e) { console.error('[comm-profile]', e.message); res.status(400).json({ error: e.message }); }
});

// PUT /api/comm-profile/:clientId/target  { scores: {...} }
router.put('/:clientId/target', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { await cp.setTarget(Number(req.params.clientId), req.body.scores || {}); res.json(await cp.getProfile(Number(req.params.clientId))); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/comm-profile/:clientId/target/derive  (Ziel neu aus der Brand Voice ableiten)
router.post('/:clientId/target/derive', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { await cp.reDeriveTarget(Number(req.params.clientId)); res.json(await cp.getProfile(Number(req.params.clientId))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
