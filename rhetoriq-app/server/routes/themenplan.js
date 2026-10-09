const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const tp = require('../lib/themenplan');

const router = express.Router();

// GET /api/themenplan/client/:clientId  (Schalter und letzte Läufe)
router.get('/client/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.clientId);
    const c = (await pool.query('SELECT themenplan_aktiv FROM clients WHERE id=$1', [id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    const { rows } = await pool.query('SELECT monat, status, kosten_usd, updated_at FROM themenplan_laeufe WHERE client_id=$1 ORDER BY monat DESC LIMIT 6', [id]);
    res.json({ aktiv: !!c.themenplan_aktiv, preisChf: 150, laeufe: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/themenplan/client/:clientId  { aktiv }
router.put('/client/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const aktiv = req.body && req.body.aktiv === true;
    const r = await pool.query('UPDATE clients SET themenplan_aktiv=$1 WHERE id=$2 RETURNING id', [aktiv, req.params.clientId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    res.json({ aktiv });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/themenplan/client/:clientId/erzeugen  (von Hand; weiterhin höchstens einmal pro Monat, Fehler und Abbrüche dürfen wiederholt werden)
router.post('/client/:clientId/erzeugen', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.clientId);
    const c = (await pool.query('SELECT themenplan_aktiv FROM clients WHERE id=$1', [id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    if (!c.themenplan_aktiv) return res.status(400).json({ error: 'Der Themenplan ist für diesen Klienten nicht aktiviert.' });
    const out = await tp.runForClient(id);
    if (out.status === 'uebersprungen') return res.status(409).json({ ...out, error: out.grund });
    if (out.status !== 'fertig') return res.status(502).json({ ...out, error: out.grund || 'Der Themenplan konnte nicht erzeugt werden.' });
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
