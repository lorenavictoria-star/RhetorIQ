const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const { brevoSend } = require('../lib/brevo');

const ADVISOR_NOTIFY_EMAIL = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// POST /api/reviews — client submits text for advisor review
router.post('/', auth, async (req, res) => {
  const { clientId, moduleLabel, originalText, note } = req.body;
  if (!originalText) return res.status(400).json({ error: 'No text provided' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO review_requests (client_id, module_label, original_text, client_note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [clientId || null, moduleLabel || null, originalText, note || null]
    );
    req.app.locals.wss.broadcast({ type: 'review_new', id: rows[0].id });
    res.json(rows[0]);

    // Notify the advisor by email so she can act even without the app open.
    // Fire-and-forget: never let email delivery affect the client-facing response.
    (async () => {
      let clientName = 'Unbekannter Klient';
      if (clientId) {
        const { rows: cRows } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
        if (cRows[0]) clientName = cRows[0].name;
      }
      const preview = originalText.length > 500 ? originalText.slice(0, 500) + '…' : originalText;

      // Include the client's own thumbs-up/down history for this module, so
      // the advisor sees at a glance what this client has liked/disliked in
      // previous attempts, not just the text submitted just now.
      let historyBlock = '';
      if (clientId && moduleLabel) {
        const { rows: pastRows } = await pool.query(
          `SELECT result, user_rating, feedback_note, created_at FROM analyses
           WHERE client_id=$1 AND module_label=$2 AND user_rating IS NOT NULL
           ORDER BY created_at DESC LIMIT 5`,
          [clientId, moduleLabel]
        );
        if (pastRows.length) {
          historyBlock = '\n\n--- Bisherige bewertete Versuche dieses Klienten für dieses Modul ---\n'
            + pastRows.map((r, i) => {
                const stamp = new Date(r.created_at).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
                const rating = r.user_rating === 1 ? '👍' : '👎';
                const snippet = (r.result || '').length > 200 ? r.result.slice(0, 200) + '…' : (r.result || '');
                return `${i + 1}. [${stamp}] ${rating}${r.feedback_note ? ' — Notiz: ' + r.feedback_note : ''}\n   ${snippet}`;
              }).join('\n\n');
        }
      }

      await brevoSend({
        to: ADVISOR_NOTIFY_EMAIL,
        subject: `RhetorIQ — Neue Freigabe-Anfrage: ${clientName}${moduleLabel ? ' (' + moduleLabel + ')' : ''}`,
        text: `Ein Klient hat einen Text zur Prüfung eingereicht.\n\nKlient: ${clientName}\nModul: ${moduleLabel || 'Nicht angegeben'}\n${note ? '\nFeedback / Auftrag des Klienten:\n' + note + '\n' : ''}\n--- Textauszug ---\n${preview}${historyBlock}\n\nJetzt bearbeiten: https://rhetoriq.ch\n`,
        senderName: 'RhetorIQ'
      });
    })().catch(e => console.error('[reviews] advisor notification email failed:', e.message));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reviews — advisor fetches all reviews still awaiting action
// (both untouched 'pending' ones and drafts saved but not yet sent — 'edited')
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM review_requests WHERE status IN ('pending', 'edited') ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reviews/:id — advisor saves edited text.
// send:true (default) marks it approved and notifies the client via WS.
// send:false just persists the draft edit as 'edited' — stays in the queue,
// no notification, so the advisor can save progress and come back later.
// Status values are constrained by review_requests_status_check to exactly
// 'pending' | 'edited' | 'approved' | 'rejected' — using anything else
// (e.g. the previous 'done') violates that constraint and 500s.
router.put('/:id', auth, async (req, res) => {
  const { editedText, send } = req.body;
  if (!editedText) return res.status(400).json({ error: 'No text provided' });
  const shouldSend = send !== false;
  try {
    const { rows } = await pool.query(
      `UPDATE review_requests
       SET edited_text = $1, status = $3, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [editedText, req.params.id, shouldSend ? 'approved' : 'edited']
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (shouldSend) {
      req.app.locals.wss.broadcast({
        type: 'review_done',
        id: rows[0].id,
        clientId: rows[0].client_id,
        editedText,
        moduleLabel: rows[0].module_label
      });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reviews/:id — advisor discards a review request entirely
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM review_requests WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
