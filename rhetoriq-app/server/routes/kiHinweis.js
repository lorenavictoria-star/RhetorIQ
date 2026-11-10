const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const { KI_SATZ, OEFFENTLICHE_TEXTARTEN } = require('../lib/kiHinweis');

const router = express.Router();

// GET /api/clients/:id/ki-hinweis  (Beraterin und der Klient selbst)
router.get('/:id/ki-hinweis', requireAuth, ownClient('id'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query('SELECT ki_hinweis FROM clients WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Klient nicht gefunden' });
    res.json({ kiHinweis: !!rows[0].ki_hinweis, satz: KI_SATZ, textarten: OEFFENTLICHE_TEXTARTEN });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/clients/:id/ki-hinweis  { kiHinweis: true|false }  (Beraterin, Hauptzugang und Rolle Admin des Klienten)
router.put('/:id/ki-hinweis', requireAuth, requireRole('admin'), ownClient('id'), async (req, res) => {
  try {
    await ensureSchema();
    if (typeof req.body.kiHinweis !== 'boolean') return res.status(400).json({ error: 'kiHinweis muss true oder false sein.' });
    await pool.query('UPDATE clients SET ki_hinweis=$1 WHERE id=$2', [req.body.kiHinweis, req.params.id]);
    res.json({ kiHinweis: req.body.kiHinweis, satz: KI_SATZ, textarten: OEFFENTLICHE_TEXTARTEN });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/clients/:id/pruefnachweis[?format=csv]  (Beraterin, Hauptzugang und Rolle Admin)
// Nachweis der Prüfungen durch die Beraterin: freigegebene Texte mit Datum, Textart und Minuten. Ohne Textinhalt.
router.get('/:id/pruefnachweis', requireAuth, requireRole('admin'), ownClient('id'), async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT id, module_label, module_tile, updated_at AS geprueft_am, minutes
       FROM review_requests WHERE client_id=$1 AND status='approved' ORDER BY updated_at DESC LIMIT 1000`, [req.params.id]);
    const liste = rows.map(r => ({ id: r.id, textart: r.module_label || '', kachel: r.module_tile || '', geprueftAm: r.geprueft_am, minuten: r.minutes == null ? null : Number(r.minutes) }));
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const { csvCell } = require('../lib/csvSafe');
      const datum = d => new Date(d).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const zeilen = [['Nr', 'Textart', 'Geprüft am', 'Minuten'].map(csvCell).join(';')]
        .concat(liste.map(r => [r.id, r.textart, datum(r.geprueftAm), r.minuten == null ? '' : r.minuten].map(csvCell).join(';')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Pruefnachweis.csv"');
      return res.send('\ufeff' + zeilen.join('\r\n') + '\r\n');
    }
    res.json({ pruefungen: liste });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
