const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const q = require('../lib/quartalsreview');
const qa = require('../lib/quartalsauswertung');
const { pool } = require('../db');

const router = express.Router();

// GET /api/quartalsreview/due  (Business-Klienten, ob der Review dieses Quartals noch offen ist)
router.get('/due', requireAdvisor, async (req, res) => {
  try { res.json(await q.dueList(req.user.id)); }
  catch (e) { console.error('[quartalsreview]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/quartalsreview/auswertung/lauf  { quartal?, clientId?, mails?, wiederholen? }
// Testlauf per Knopf: ohne clientId für alle berechtigten Klienten der Beraterin (wie der Zeitplan), sonst für einen Klienten.
// mails:false erzeugt die Auswertung ohne Versand. wiederholen:true ersetzt eine vorhandene Auswertung des Quartals.
router.post('/auswertung/lauf', requireAdvisor, async (req, res) => {
  try {
    const b = req.body || {};
    const opts = { mails: b.mails !== false, wiederholen: b.wiederholen === true };
    if (b.quartal !== undefined) { if (!q.validQuartal(b.quartal)) return res.status(400).json({ error: 'Ungültiges Quartal.' }); opts.quartal = b.quartal; }
    if (b.clientId !== undefined) {
      const own = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2 AND geloescht_am IS NULL', [Number(b.clientId), req.user.id]);
      if (!own.rows.length) return res.status(404).json({ error: 'Klient nicht gefunden.' });
      return res.json([{ clientId: own.rows[0].id, ...(await qa.runForClient(own.rows[0].id, opts)) }]);
    }
    const mine = new Set((await pool.query('SELECT id FROM clients WHERE advisor_id=$1', [req.user.id])).rows.map(r => r.id));
    const out = [];
    for (const c of (await qa.berechtigte()).filter(x => mine.has(x.id))) {
      if (!(await require('../lib/budget').allow('quartalsreview')).ok) { out.push({ clientId: c.id, status: 'uebersprungen', grund: 'Tagesbudget erreicht.' }); continue; }
      out.push({ clientId: c.id, ...(await qa.runForClient(c.id, opts)) });
    }
    res.json(out);
  } catch (e) { console.error('[quartalsreview]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/quartalsreview/:clientId/auswertung.docx?quartal=2026-Q3  (gespeicherte Auswertung als Word)
router.get('/:clientId/auswertung.docx', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const quartal = q.validQuartal(req.query.quartal) ? req.query.quartal : qa.vorherigesQuartal();
    const r = await qa.buildAuswertung(Number(req.params.clientId), quartal);
    const safe = String(r.name).replace(/[^A-Za-z0-9ÄÖÜäöüéèàç _-]/g, '').trim().replace(/\s+/g, '_') || 'Klient';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Quartalsauswertung_${encodeURIComponent(safe)}_${r.quartal}.docx"`
    });
    res.send(r.buffer);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// GET /api/quartalsreview/:clientId/auswertung?quartal=  (Stand des Laufs: Status, Mails, Kosten)
router.get('/:clientId/auswertung', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const quartal = q.validQuartal(req.query.quartal) ? req.query.quartal : qa.vorherigesQuartal();
    const r = (await pool.query('SELECT status, kosten_usd, mail_beraterin_am, mail_klient_am, grund, updated_at, (ki_json IS NOT NULL) AS vorhanden FROM quartalsreview_laeufe WHERE client_id=$1 AND quartal=$2', [Number(req.params.clientId), quartal])).rows[0];
    res.json({ quartal, lauf: r || null });
  } catch (e) { console.error('[quartalsreview]', e.message); res.status(500).json({ error: 'Internal server error' }); }
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
