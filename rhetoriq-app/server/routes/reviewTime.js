const express = require('express');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const rt = require('../lib/reviewTime');

const router = express.Router();

// PUT /api/review-time/review/:id  { minutes }  (nur Beraterin, nur eigene Klienten)
router.put('/review/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    const { rows } = await pool.query(
      `SELECT r.id FROM review_requests r JOIN clients c ON c.id = r.client_id WHERE r.id=$1 AND (c.advisor_id=$2 OR c.advisor_id IS NULL)`, [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Freigabe nicht gefunden.' });
    const out = await rt.setMinutes(id, req.body.minutes);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/review-time/mine?month=2026-10  (Klient: eigene Zeitübersicht mit Monatsabo und Mehraufwand; nur Hauptzugang und Admin)
router.get('/mine', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Nur für Klienten.' });
    if (req.user.clientUserRole && req.user.clientUserRole !== 'admin') return res.status(403).json({ error: 'Nicht erlaubt.' });
    const s = await rt.clientSummary(req.user.clientId, req.query.month);
    if (!s) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    // Nur, was der Klient sehen soll
    res.json({ month: s.month, aboChf: s.aboChf, totalChf: s.totalChf, includedMinutes: s.includedMinutes, usedMinutes: s.usedMinutes,
      extraMinutes: s.extraMinutes, billedMinutes: s.billedMinutes, extraChf: s.extraChf, rateChf: s.rateChf, step: s.step,
      rows: s.rows.map(r => ({ id: r.id, module_label: r.module_label, minutes: r.minutes, time_logged_at: r.time_logged_at })) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/review-time/client/:clientId?month=2026-10
router.get('/client/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const s = await rt.clientSummary(Number(req.params.clientId), req.query.month);
    if (!s) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/review-time/client/:clientId/included  { minutes | null }
router.put('/client/:clientId/included', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const v = req.body.minutes;
    const m = v === null || v === '' || v === undefined ? null : Math.round(Number(v));
    if (m !== null && (!Number.isFinite(m) || m < 0 || m > 6000)) return res.status(400).json({ error: 'Ungültige Minutenzahl.' });
    await pool.query('UPDATE clients SET included_minutes=$1 WHERE id=$2', [m, req.params.clientId]);
    res.json(await rt.clientSummary(Number(req.params.clientId), req.query.month));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/review-time/export?month=2026-10  (CSV für die Rechnung)
router.get('/export', requireAdvisor, async (req, res) => {
  try {
    const month = rt.monthRange(req.query.month).month;
    const csv = await rt.exportCsv(req.user.id, month);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="Zeiterfassung_${month}.csv"` });
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
