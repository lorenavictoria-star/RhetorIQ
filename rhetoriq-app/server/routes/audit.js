const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function requireAdvisor(req, res, next) {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// GET /api/audit/:clientId — full audit log for a client
router.get('/:clientId', requireAuth, requireAdvisor, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows: clientRows } = await pool.query(
      'SELECT id FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!clientRows[0]) return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(
      `SELECT id, module, module_label, generated_by, created_at,
              LEFT(result, 200) as result_preview
       FROM analyses
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audit/:clientId/export — CSV download
router.get('/:clientId/export', requireAuth, requireAdvisor, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows: clientRows } = await pool.query(
      'SELECT id, name FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!clientRows[0]) return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(
      `SELECT id, module, module_label, generated_by, created_at,
              LEFT(result, 500) as result_preview
       FROM analyses
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId]
    );

    const esc = v => `"${(v || '').toString().replace(/"/g, '""').replace(/\n/g, ' ')}"`;
    const csv = [
      ['ID', 'Modul', 'Modul-Label', 'Erstellt von', 'Datum/Uhrzeit', 'Vorschau'].map(esc).join(','),
      ...rows.map(r => [
        r.id,
        r.module,
        r.module_label || '',
        r.generated_by || 'Klient',
        new Date(r.created_at).toLocaleString('de-CH'),
        r.result_preview || ''
      ].map(esc).join(','))
    ].join('\r\n');

    const filename = `rhetoriq-audit-${clientRows[0].name.replace(/\s+/g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audit/:clientId/feedback-learnings — current consolidated
// per-category summaries (what actually gets injected into generation),
// grouped by module.
router.get('/:clientId/feedback-learnings', requireAuth, requireAdvisor, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows: clientRows } = await pool.query(
      'SELECT id FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!clientRows[0]) return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(
      `SELECT module_key, category, summary, updated_at
       FROM client_feedback_learnings
       WHERE client_id=$1
       ORDER BY module_key, category`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audit/:clientId/feedback-history — full raw feedback log, never
// injected into prompts, kept purely for advisor review.
router.get('/:clientId/feedback-history', requireAuth, requireAdvisor, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows: clientRows } = await pool.query(
      'SELECT id FROM clients WHERE id=$1 AND advisor_id=$2',
      [clientId, req.user.id]
    );
    if (!clientRows[0]) return res.status(404).json({ error: 'Client not found' });

    const { rows } = await pool.query(
      `SELECT id, module_key, category, rating, note, created_at
       FROM client_feedback_history
       WHERE client_id=$1
       ORDER BY created_at DESC
       LIMIT 300`,
      [clientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
