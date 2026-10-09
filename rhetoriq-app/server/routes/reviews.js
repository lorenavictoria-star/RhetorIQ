const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const { queueEmail } = require('../lib/emailOutbox');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { advisorScopeSql } = require('../middleware/ownership');
const { requireRole } = require('../middleware/roles');
const { ensureSchema } = require('../lib/schemaRedesign');
const { saveFile } = require('../lib/fileStore');
const { entwurfName, auftragBlock } = require('../lib/onboardingMails');
const { learnFromReview } = require('../lib/learnFromCorrections');
const { saveGoldFromReview } = require('../lib/goldtexte');

const heute = () => new Date().toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });

// Legt den an den Klienten gesendeten Text zusätzlich im Ordner 'gesendet' ab. Fehler werden nur geloggt.
async function storeSentCopy(review, text) {
  try {
    if (!review.client_id) return;
    await ensureSchema();
    await saveFile({
      clientId: review.client_id, folder: 'gesendet', mime: 'text/plain; charset=utf-8',
      name: entwurfName(review.module_label, heute()), buffer: Buffer.from(String(text), 'utf8')
    });
  } catch (e) {
    console.error('[reviews] storing sent copy failed:', e.message);
  }
}

// The advisor now finishes reviews from inside the per-client Workspace
// (rather than always jumping into the client's own module UI), so "An
// Klient senden" must actively notify the client by email — the existing WS
// broadcast only reaches a client who happens to have the app open right now.
async function notifyClientOfReviewedText(clientId, moduleLabel, editedText) {
  if (!clientId) return;
  try {
    const { rows } = await pool.query('SELECT name, email FROM clients WHERE id=$1', [clientId]);
    const client = rows[0];
    if (!client?.email) return;
    await queueEmail({
      kind: 'review-response',
      to: client.email,
      subject: `RhetorIQ — Ihr überarbeiteter Text ist bereit${moduleLabel ? ' (' + moduleLabel + ')' : ''}`,
      text: `Guten Tag${client.name ? ' ' + client.name : ''}\n\nIhre Beraterin hat den eingereichten Text überarbeitet. Der finale Text:\n\n${editedText}\n\nSie finden ihn auch direkt in Ihrem RhetorIQ-Konto unter der jeweiligen Anfrage.\n\nFreundliche Grüsse\nRhetorIQ`,
      senderName: 'RhetorIQ'
    });
  } catch (e) {
    console.error('[reviews] client notification email failed:', e.message);
  }
}

const ADVISOR_NOTIFY_EMAIL = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

// Anmeldung mit Widerrufsprüfung (token_version), wie überall sonst
const auth = requireAuth;

// POST /api/reviews — client submits text for advisor review
router.post('/', auth, requireRole('editor'), async (req, res) => {
  const { moduleLabel, originalText, note, moduleKey, moduleTile, reviewContext, revisionHistory } = req.body;
  // Klienten reichen nur für sich selbst ein, egal was im Aufruf steht.
  const clientId = req.user.role === 'client' ? req.user.clientId : req.body.clientId;
  if (!originalText) return res.status(400).json({ error: 'No text provided' });
  // Optional: freier Auftrag des Klienten und "Bis spätestens" (ISO). Ohne Frist gilt created_at + 3 Stunden.
  const instruction = typeof req.body.instruction === 'string' ? req.body.instruction.trim().slice(0, 4000) : '';
  let dueGiven = null;
  if (req.body.dueAt) {
    const d = new Date(req.body.dueAt);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Ungültige Frist (dueAt).' });
    if (d.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'Die Frist liegt in der Vergangenheit.' });
    dueGiven = d;
  }
  const dueAt = dueGiven || new Date(Date.now() + 3 * 60 * 60 * 1000);
  // Self-revision rounds (via the follow-up box) the client already did on
  // this exact text before sending it on — stored inside review_context so
  // openReviewInModule() and the notification email both have it.
  const contextWithHistory = reviewContext
    ? { ...reviewContext, revisionHistory: Array.isArray(revisionHistory) ? revisionHistory : [] }
    : (Array.isArray(revisionHistory) && revisionHistory.length ? { revisionHistory } : null);
  try {
    const baseParams = [clientId || null, moduleLabel || null, originalText, note || null, moduleKey || null, moduleTile || null, contextWithHistory ? JSON.stringify(contextWithHistory) : null];
    // Neue Spalten (instruction, due_at) nur nutzen, wenn das Schema bereitsteht; sonst wie bisher.
    const schemaOk = await ensureSchema().then(() => true, e => { console.error('[reviews] schema ensure failed:', e.message); return false; });
    const { rows } = schemaOk
      ? await pool.query(
          `INSERT INTO review_requests (client_id, module_label, original_text, client_note, module_key, module_tile, review_context, instruction, due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [...baseParams, instruction || null, dueAt])
      : await pool.query(
          `INSERT INTO review_requests (client_id, module_label, original_text, client_note, module_key, module_tile, review_context)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          baseParams);
    req.app.locals.wss.toAdvisors({ type: 'review_new', id: rows[0].id });
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

      // Self-revision rounds the client already ran on THIS text (via the
      // follow-up box) before deciding to send it on — different from
      // historyBlock above, which covers older, separate submissions.
      let revisionBlock = '';
      if (Array.isArray(revisionHistory) && revisionHistory.length) {
        revisionBlock = '\n\n--- Eigene Anpassungsrunden des Klienten an diesem Text (vor dem Senden) ---\n'
          + revisionHistory.map((h, i) => `${i + 1}. Auftrag: ${h.note || '—'}\n   Stand davor: ${(h.textBefore || '').trim() || '—'}`).join('\n\n');
      }

      await queueEmail({
        kind: 'review-request',
        to: ADVISOR_NOTIFY_EMAIL,
        subject: `RhetorIQ — Neue Freigabe-Anfrage: ${clientName}${moduleLabel ? ' (' + moduleLabel + ')' : ''}`,
        text: `Ein Klient hat einen Text zur Prüfung eingereicht.\n\nKlient: ${clientName}\nModul: ${moduleLabel || 'Nicht angegeben'}\n${note ? '\nFeedback / Auftrag des Klienten:\n' + note + '\n' : ''}${(instruction || dueGiven) ? auftragBlock({ instruction: instruction && instruction !== (note || '').trim() ? instruction : '', dueAt }) : ''}\n--- Textauszug ---\n${preview}${revisionBlock}${historyBlock}\n\nJetzt bearbeiten: https://rhetoriq.ch/?review=${rows[0].id}\n`,
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
router.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema().catch(e => console.error('[reviews] schema ensure failed:', e.message)); // liefert instruction/due_at mit
    const { rows } = await pool.query(
      `SELECT * FROM review_requests WHERE status IN ('pending', 'edited') AND ${advisorScopeSql('client_id', 1)} ORDER BY created_at DESC`,
      [req.user.id]
    );
    // So the advisor sees what this client has liked/disliked before, not just
    // the text currently up for review — small N here, pending reviews are few.
    // Antwortzeit je Paket: Stimme 1 Werktag (24 Stunden), alle anderen 3 Stunden
    try {
      const ids = [...new Set(rows.map(r => r.client_id).filter(Boolean))];
      const plans = ids.length ? (await pool.query('SELECT id, recommended_plan FROM clients WHERE id = ANY($1)', [ids])).rows : [];
      const byId = new Map(plans.map(p => [p.id, p.recommended_plan]));
      rows.forEach(rv => { rv.sla_hours = byId.get(rv.client_id) === 'stimme' ? 24 : 3; });
    } catch (e) { rows.forEach(rv => { rv.sla_hours = 3; }); }
    await Promise.all(rows.map(async rv => {
      if (!rv.client_id || !rv.module_label) { rv.pastRatings = []; return; }
      const { rows: past } = await pool.query(
        `SELECT result, user_rating, feedback_note, created_at FROM analyses
         WHERE client_id=$1 AND module_label=$2 AND user_rating IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`,
        [rv.client_id, rv.module_label]
      );
      rv.pastRatings = past;
    }));
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
router.put('/:id', requireAdvisor, async (req, res) => {
  const { editedText, send } = req.body;
  if (!editedText) return res.status(400).json({ error: 'No text provided' });
  const shouldSend = send !== false;
  try {
    const { rows } = await pool.query(
      `UPDATE review_requests
       SET edited_text = $1, status = $3, updated_at = NOW()
       WHERE id = $2 AND ${advisorScopeSql('client_id', 4)} RETURNING *`,
      [editedText, req.params.id, shouldSend ? 'approved' : 'edited', req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (shouldSend) {
      req.app.locals.wss.toClient(rows[0].client_id, {
        type: 'review_done',
        id: rows[0].id,
        clientId: rows[0].client_id,
        editedText,
        moduleLabel: rows[0].module_label
      });
      notifyClientOfReviewedText(rows[0].client_id, rows[0].module_label, editedText)
        .catch(e => console.error('[reviews] notify failed:', e.message));
      storeSentCopy(rows[0], editedText);
      require('../lib/stimmnaehe').fuerFreigabe(rows[0]);   // lokale Messung der gesendeten Fassung, ohne KI, wirft nie
      // Aus den Korrekturen lernen: im Hintergrund, höchstens ein günstiger Aufruf, nur bei echter Änderung
      saveGoldFromReview(rows[0].id).catch(e => console.error('[gold] failed:', e.message));
      learnFromReview(rows[0].id).catch(e => console.error('[learning] failed:', e.message));
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reviews/:id/save-draft — advisor stores the given text as a file in the
// client's 'entwuerfe' folder ("<Modul> · <Datum>.txt"). Does not change the review itself.
router.post('/:id/save-draft', requireAdvisor, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID.' });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'Kein Text übergeben.' });
    if (text.length > 200000) return res.status(400).json({ error: 'Text ist zu lang.' });
    const { rows } = await pool.query(`SELECT id, client_id, module_label FROM review_requests WHERE id=$1 AND ${advisorScopeSql('client_id', 2)}`, [id, req.user.id]);
    const rv = rows[0];
    if (!rv) return res.status(404).json({ error: 'Not found' });
    if (!rv.client_id) return res.status(400).json({ error: 'Diese Anfrage gehört zu keinem Klienten.' });
    await ensureSchema();
    const label = String(req.body.moduleLabel || rv.module_label || '').trim().slice(0, 80);
    const file = await saveFile({
      clientId: rv.client_id, folder: 'entwuerfe', mime: 'text/plain; charset=utf-8',
      name: entwurfName(label, heute()), buffer: Buffer.from(text, 'utf8')
    });
    res.status(201).json(file);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reviews/:id — advisor discards a review request entirely
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM review_requests WHERE id=$1 AND ${advisorScopeSql('client_id', 2)}`, [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
