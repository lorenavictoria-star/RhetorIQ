const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { brevoSend } = require('../lib/brevo');
const { generateText, resolveModelId } = require('../lib/aiProvider');

const ADVISOR_NOTIFY_EMAIL = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

const SOLUTION_SYSTEM_PROMPT = `Du bist ein erfahrener Product-Lead für RhetorIQ, eine SaaS-Plattform, die Unternehmen beim Verfassen professioneller Texte (Reden, Präsentationen, LinkedIn-Posts, E-Mails etc.) mithilfe von KI unterstützt. Eine Nutzerin oder ein Nutzer hat gerade eine kurze Feedback-Notiz direkt aus der App heraus abgeschickt.

Deine Aufgabe: Lies die Notiz und schlage in wenigen Sätzen eine konkrete, umsetzbare Lösung vor — so, wie ein erfahrener Product-Lead es einer Gründerin in einer kurzen internen Notiz mitteilen würde.

Regeln:
- Antworte auf Deutsch (Schweizer Rechtschreibung, "ss" statt "ß").
- Schreibe echte Umlaute (ä, ö, ü), nie "ae"/"oe"/"ue".
- Maximal 4-6 Sätze. Kein Blabla, keine Einleitung wie "Vielen Dank für das Feedback".
- Wenn das Feedback ein Bug ist: benenne die wahrscheinliche Ursache und einen konkreten technischen Lösungsansatz.
- Wenn es ein Wunsch/eine Idee ist: schlage eine konkrete, einfache Umsetzung vor (kein Over-Engineering).
- Wenn die Notiz zu vage ist, um eine sinnvolle Lösung vorzuschlagen, sage das kurz und nenne, welche Rückfrage an die Person nötig wäre — erfinde keine Annahmen als Tatsachen.
- Kein Fazit-Satz am Schluss, keine Grussformel.`;

// POST /api/feedback — either role submits a short note from the floating
// feedback button. Fire-and-forget email to the advisor with an AI-drafted
// solution suggestion attached, so she can triage without opening the app.
router.post('/', requireAuth, async (req, res) => {
  const { message, pageContext } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'No feedback text provided' });

  const clientId = req.user.role === 'client' ? req.user.clientId : null;
  const advisorId = req.user.role === 'advisor' ? req.user.id : (req.user.advisorId || null);
  const authorLabel = req.user.role === 'advisor' ? (req.user.name || 'Beraterin') : (req.user.clientName || 'Klient');

  try {
    const { rows } = await pool.query(
      `INSERT INTO feedback_notes (client_id, advisor_id, author_role, author_label, page_context, message)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [clientId, advisorId, req.user.role, authorLabel, pageContext || null, message.trim()]
    );
    res.json(rows[0]);

    (async () => {
      let solution = '';
      try {
        const resp = await generateText({
          system: SOLUTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Feedback-Notiz von ${authorLabel} (${req.user.role === 'advisor' ? 'Beraterin' : 'Klient'}):\n"${message.trim()}"\n\nSeite/Kontext: ${pageContext || 'nicht angegeben'}` }],
          maxTokens: 500,
          model: resolveModelId('sonnet')
        });
        solution = resp.text || '';
        if (solution) {
          await pool.query('UPDATE feedback_notes SET ai_solution=$1 WHERE id=$2', [solution, rows[0].id]);
        }
      } catch (e) {
        console.error('[feedback] AI solution draft failed:', e.message);
        solution = '(Konnte automatisch keinen Lösungsvorschlag erstellen.)';
      }

      await brevoSend({
        to: ADVISOR_NOTIFY_EMAIL,
        subject: `RhetorIQ — Neues Feedback von ${authorLabel}`,
        text: `${authorLabel} (${req.user.role === 'advisor' ? 'Beraterin' : 'Klient'}) hat Feedback hinterlassen.\n\nSeite/Kontext: ${pageContext || 'nicht angegeben'}\n\n--- Feedback ---\n${message.trim()}\n\n--- Vorschlag zur Umsetzung ---\n${solution}\n`,
        senderName: 'RhetorIQ'
      });
    })().catch(e => console.error('[feedback] notification email failed:', e.message));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/feedback — advisor-only list, most recent first
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
  try {
    const { rows } = await pool.query('SELECT * FROM feedback_notes ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
