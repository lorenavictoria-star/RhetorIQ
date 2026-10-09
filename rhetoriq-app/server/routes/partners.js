const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const pt = require('../lib/partners');

const router = express.Router();

// Alle Routen nur für die Beraterin.
router.get('/', requireAdvisor, async (req, res) => {
  try { res.json({ partners: await pt.list(), baseUrl: process.env.PUBLIC_SITE_URL || 'https://rhetoriq.ch' }); }
  catch (e) { console.error('[partners]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/', requireAdvisor, async (req, res) => {
  try { res.status(201).json(await pt.create({ name: req.body.name, kontaktEmail: req.body.kontaktEmail, code: req.body.code })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requireAdvisor, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    const r = await pt.setActive(id, req.body.aktiv !== false);
    if (!r) return res.status(404).json({ error: 'Partner nicht gefunden.' });
    res.json(r);
  } catch (e) { console.error('[partners]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/partners/:id/provision?month=2026-10[&format=csv]
router.get('/:id/provision', requireAdvisor, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    const r = await pt.provision(id, req.query.month);
    if (!r) return res.status(404).json({ error: 'Partner nicht gefunden.' });
    if (String(req.query.format) === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="Provision_${r.partner.code}_${r.month}.csv"` });
      return res.send(pt.toCsv(r));
    }
    res.json(r);
  } catch (e) { console.error('[partners]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
