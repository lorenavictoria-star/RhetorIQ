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
  const { clientId, moduleLabel, originalText } = req.body;
  if (!originalText) return res.status(400).json({ error: 'No text provided' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO review_requests (client_id, module_label, original_text)
       VALUES ($1, $2, $3) RETURNING *`,
      [clientId || null, moduleLabel || null, originalText]
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
      await brevoSend({
        to: ADVISOR_NOTIFY_EMAIL,
        subject: `RhetorIQ — Neue Freigabe-Anfrage: ${clientName}${moduleLabel ? ' (' + moduleLabel + ')' : ''}`,
        text: `Ein Klient hat einen Text zur Prüfung eingereicht.\n\nKlient: ${clientName}\nModul: ${moduleLabel || 'Nicht angegeben'}\n\n--- Textauszug ---\n${preview}\n\nJetzt bearbeiten: https://rhetoriq.ch\n`,
        senderName: 'RhetorIQ'
      });
    })().catch(e => console.error('[reviews] advisor notification email failed:', e.message));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reviews — advisor fetches all pending reviews
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM review_requests WHERE status = 'pending' ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reviews/:id — advisor saves edited text, client is notified via WS
router.put('/:id', auth, async (req, res) => {
  const { editedText } = req.body;
  if (!editedText) return res.status(400).json({ error: 'No text provided' });
  try {
    const { rows } = await pool.query(
      `UPDATE review_requests
       SET edited_text = $1, status = 'done', updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [editedText, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    req.app.locals.wss.broadcast({
      type: 'review_done',
      id: rows[0].id,
      clientId: rows[0].client_id,
      editedText,
      moduleLabel: rows[0].module_label
    });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
