const express = require('express');
const { pool } = require('../db');
const { requireAdvisor } = require('../middleware/auth');
const { ensureSchema } = require('../lib/schemaRedesign');
const { CATEGORIES } = require('../lib/learnFromCorrections');

// Lernvorschläge aus den Korrekturen der Beraterin.
//   GET  /api/learning?client_id=&status=offen   Liste (nach Häufigkeit)
//   POST /api/learning/:id/accept {observation?}  in das gelernte Feedback des Klienten übernehmen
//   POST /api/learning/:id/reject                 verwerfen (kommt nicht wieder)
const router = express.Router();
const MAX_SENTENCES = 8;   // pro Kategorie bleiben die neuesten acht Vorlieben

function sentences(t) {
  return String(t || '').split(/(?<=[.!?…])\s+/).map(x => x.trim()).filter(Boolean);
}

router.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const status = ['offen', 'angenommen', 'abgelehnt'].includes(req.query.status) ? req.query.status : 'offen';
    const params = [status, req.user.id];
    let where = `ls.status=$1 AND c.advisor_id=$2`;
    if (req.query.client_id) { params.push(parseInt(req.query.client_id, 10)); where += ` AND ls.client_id=$3`; }
    const { rows } = await pool.query(
      `SELECT ls.id, ls.client_id, ls.module_key, ls.module_label, ls.category, ls.observation, ls.example_before, ls.example_after,
              ls.occurrences, ls.status, ls.created_at, ls.updated_at
       FROM learning_suggestions ls JOIN clients c ON c.id = ls.client_id
       WHERE ${where} ORDER BY ls.occurrences DESC, ls.updated_at DESC LIMIT 100`, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function loadOwn(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return null;
  const { rows } = await pool.query(
    `SELECT ls.* FROM learning_suggestions ls JOIN clients c ON c.id = ls.client_id WHERE ls.id=$1 AND c.advisor_id=$2`,
    [id, req.user.id]);
  return rows[0] || null;
}

router.post('/:id/accept', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const ls = await loadOwn(req);
    if (!ls) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    if (ls.status !== 'offen') return res.status(409).json({ error: 'Dieser Vorschlag wurde schon bearbeitet.' });
    let text = typeof req.body?.observation === 'string' && req.body.observation.trim() ? req.body.observation.trim().slice(0, 300) : ls.observation;
    if (!/[.!?…]$/.test(text)) text += '.';
    const category = CATEGORIES.includes(ls.category) ? ls.category : 'SONSTIGES';
    const { rows: cur } = await pool.query(
      'SELECT summary FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3',
      [ls.client_id, ls.module_key, category]);
    const list = sentences(cur[0] && cur[0].summary);
    if (!list.some(s => s.toLowerCase() === text.toLowerCase())) list.push(text);
    const summary = list.slice(-MAX_SENTENCES).join(' ');
    await pool.query(
      `INSERT INTO client_feedback_learnings (client_id, module_key, category, summary, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (client_id, module_key, category) DO UPDATE SET summary=$4, updated_at=NOW()`,
      [ls.client_id, ls.module_key, category, summary]);
    // Spur im Protokoll des gelernten Feedbacks, falls die Tabelle da ist
    await pool.query(
      'INSERT INTO client_feedback_history (client_id, module_key, category, rating, note) VALUES ($1,$2,$3,$4,$5)',
      [ls.client_id, ls.module_key, category, 1, 'Aus Korrekturen der Beraterin: ' + text]).catch(() => {});
    await pool.query(`UPDATE learning_suggestions SET status='angenommen', observation=$2, updated_at=NOW() WHERE id=$1`, [ls.id, text]);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/reject', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const ls = await loadOwn(req);
    if (!ls) return res.status(404).json({ error: 'Vorschlag nicht gefunden.' });
    await pool.query(`UPDATE learning_suggestions SET status='abgelehnt', updated_at=NOW() WHERE id=$1`, [ls.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
