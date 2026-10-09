const express = require('express');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const tp = require('../lib/themenplan');
const wahl = require('../lib/themenwahl');
const { zerlege } = require('../lib/newsletterHtml');

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

// ── Themenwahl durch den Klienten ─────────────────────────────────────────────
function nichtNurLesend(req, res, next) {
  if (req.user && req.user.readOnly) return res.status(403).json({ error: 'In dieser Ansicht lässt sich nichts ändern.' });
  next();
}
const laeuft = new Set();   // verhindert doppeltes Erstellen für denselben Klienten

async function aktivVon(id) {
  const c = (await pool.query('SELECT themenplan_aktiv FROM clients WHERE id=$1', [id])).rows[0];
  return !!(c && c.themenplan_aktiv);
}

// GET /api/themenplan/mein/:clientId: Stand für die Oberfläche (aktiv, Angaben zum Monat, freigegebener Plan, bisherige Wahl)
// Klienten sehen den Plan erst, wenn die Beraterin ihn gesendet hat.
router.get('/mein/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.clientId);
    const aktiv = await aktivVon(id);
    const m = wahl.erlaubteMonate();
    const out = { aktiv, monate: m };
    if (!aktiv) return res.json(out);
    out.newsletterErlaubt = await require('../lib/moduleAccess').textartFuerKlient(id, 'newsletter');
    out.eingabe = { aktuell: { monat: m.aktuell, ...(await wahl.leseEingabe(id, m.aktuell)) }, naechster: { monat: m.naechster, ...(await wahl.leseEingabe(id, m.naechster)) } };
    const tag = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', day: 'numeric' }).format(new Date()));
    out.erinnerung = tag >= 20 && !out.eingabe.naechster.text;
    const plan = await wahl.ladePlan(id);
    if (plan && plan.freigegeben) {
      out.plan = { monat: plan.monat, themen: plan.themen };
      out.auswahl = await wahl.ladeAuswahl(id, plan.monat);
    } else if (plan) {
      out.planWartet = true;
    }
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/themenplan/eingabe/:clientId  { monat, text }: «Was passiert bei Ihnen im nächsten Monat?» (Klient mit Rolle admin oder editor, Beraterin)
router.put('/eingabe/:clientId', requireAuth, requireRole('editor'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.clientId);
    if (!(await aktivVon(id))) return res.status(403).json({ error: 'Das Zusatzmodul «Automatisch Themen und Ideen senden» ist nicht aktiv.' });
    const m = wahl.erlaubteMonate();
    const monat = String((req.body && req.body.monat) || m.naechster);
    if (monat !== m.aktuell && monat !== m.naechster) return res.status(400).json({ error: 'Angaben lassen sich nur für den laufenden und den nächsten Monat eintragen.' });
    const text = req.body && req.body.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'Bitte einen Text eintragen.' });
    const rolle = req.user.role === 'advisor' ? 'beraterin' : (req.user.clientUserRole || 'admin');
    const r = await wahl.speichereEingabe(id, monat, text, rolle);
    res.json({ ok: true, monat, text: r.text });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/themenplan/auswahl/:clientId  { monat, auswahl: [{ idx, wunsch }] }  (1 bis 3 Themen)
// Erstellt aus den gewählten Themen einen Newsletter-Entwurf in der Stimme des Klienten. Er geht zur Beraterin in die Freigabe.
router.post('/auswahl/:clientId', requireAuth, requireRole('editor'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  const id = Number(req.params.clientId);
  try {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Die Themen wählt der Klient.' });
    await ensureSchema();
    if (!(await aktivVon(id))) return res.status(403).json({ error: 'Das Zusatzmodul «Automatisch Themen und Ideen senden» ist nicht aktiv.' });
    // Der Newsletter-Entwurf ist nur möglich, wenn die Textart Newsletter für den Klienten freigeschaltet ist (vor allen Kosten)
    if (!(await require('../lib/moduleAccess').textartFuerKlient(id, 'newsletter'))) return res.status(403).json({ error: 'Die Textart Newsletter ist für Ihr Konto nicht freigeschaltet. Bitte wenden Sie sich an Ihre Beraterin.', modulGesperrt: true });
    const monat = String((req.body && req.body.monat) || '');
    const roh = req.body && req.body.auswahl;
    if (!Array.isArray(roh) || roh.length < 1 || roh.length > wahl.MAX_WAHL) return res.status(400).json({ error: `Bitte wählen Sie ein bis drei Themen.` });
    const auswahl = [];
    for (const a of roh) {
      const idx = Number(a && a.idx);
      if (!Number.isInteger(idx) || idx < 0 || auswahl.some(x => x.idx === idx)) return res.status(400).json({ error: 'Die Auswahl ist ungültig.' });
      auswahl.push({ idx, wunsch: typeof (a && a.wunsch) === 'string' ? a.wunsch : '' });
    }
    const plan = await wahl.ladePlan(id, monat);
    if (!plan) return res.status(404).json({ error: 'Für diesen Monat gibt es keinen Themenplan.' });
    if (!plan.freigegeben) return res.status(409).json({ error: 'Der Themenplan ist noch nicht freigegeben.' });
    if (auswahl.some(a => a.idx >= plan.themen.length)) return res.status(400).json({ error: 'Die Auswahl ist ungültig.' });

    // Dieselben Schranken wie beim Text-Generator: Abo (402), Monatskontingent (429), Tagesgrenze (429); dazu das Tagesbudget der Funktion
    const abo = require('../lib/abo');
    const row = await abo.clientRow(id);
    const zg = abo.zugang(row, {});
    if (!zg.ok) return res.status(402).json(abo.antwort402(zg, id));
    try {
      const v = await abo.verbrauch(id, row && row.monthly_token_limit);
      if (!v.unbegrenzt && v.used >= v.limit) return res.status(429).json({ error: 'Monatliches Nutzungskontingent erreicht. Bitte kontaktieren Sie Ihre Beraterin für eine Erweiterung.', quotaExceeded: true, used: v.used, limit: v.limit, clientId: id });
    } catch (e) { console.error('[themenwahl] Kontingentprüfung:', e.message); }
    const cap = await require('../lib/costBrake').checkDailyCap(req.user, id);
    if (!cap.ok) return res.status(429).json({ error: cap.error, dailyCapReached: true, scope: cap.scope });
    const b = await require('../lib/budget').allow('themenwahl');
    if (!b.ok) return res.status(429).json({ error: 'Die Newsletter-Erstellung ist für heute ausgelastet. Bitte versuchen Sie es morgen wieder.', tagesbudget: true });

    if (laeuft.has(id)) return res.status(409).json({ error: 'Ihr Newsletter wird gerade erstellt. Bitte warten Sie einen Moment.' });
    laeuft.add(id);
    let out;
    try { const advisorId = (await pool.query('SELECT advisor_id FROM clients WHERE id=$1', [id])).rows[0]?.advisor_id || null;
      out = await tp.newsletterAusAuswahl(id, { plan, auswahl, advisorId }); }
    finally { laeuft.delete(id); }
    if (out.status !== 'fertig') return res.status(out.status === 'abgebrochen' ? 422 : 502).json({ error: out.grund || 'Der Newsletter konnte nicht erstellt werden.' });

    // Beraterin informieren (wie bei jeder Freigabe-Anfrage); Fehler hier ändern die Antwort nicht
    try {
      req.app.locals.wss.toAdvisors({ type: 'review_new', id: out.reviewId });
      const name = (await pool.query('SELECT name FROM clients WHERE id=$1', [id])).rows[0]?.name || 'Klient';
      for (const adv of require('../lib/notify').advisorEmails()) {
        await require('../lib/emailOutbox').queueEmail({
          kind: 'review-request', to: adv, subject: `RhetorIQ, neue Freigabe-Anfrage: ${name} (Newsletter-Entwurf aus Themenwahl)`,
          text: `${name} hat im Themenplan ${auswahl.length} Thema(en) gewählt und einen Newsletter-Entwurf erstellen lassen.\n\nJetzt bearbeiten: https://rhetoriq.ch/?review=${out.reviewId}\n`, senderName: 'RhetorIQ'
        });
      }
    } catch (e) { console.error('[themenwahl] Benachrichtigung:', e.message); }
    res.json({ ok: true, reviewId: out.reviewId, themen: out.themen });
  } catch (e) { console.error('[themenwahl]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/themenplan/newsletter/:clientId: freigegebene Newsletter (für «An Klaviyo senden»)
router.get('/newsletter/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.clientId);
    const { rows } = await pool.query(
      `SELECT id, edited_text, original_text, updated_at FROM review_requests
       WHERE client_id=$1 AND status='approved' AND (module_tile='newsletter' OR LOWER(COALESCE(module_label,'')) LIKE '%newsletter%')
       ORDER BY updated_at DESC LIMIT 12`, [id]);
    const ue = (await pool.query('SELECT review_id, created_at FROM klaviyo_uebertragungen WHERE client_id=$1 ORDER BY created_at DESC', [id])).rows;
    res.json({
      newsletter: rows.map(r => {
        const t = r.edited_text || r.original_text || '';
        const z = zerlege(t);
        const u = ue.find(x => Number(x.review_id) === Number(r.id));
        return { reviewId: r.id, betreff: z.betreff || (z.body.split('\n').find(l => l.trim()) || 'Newsletter').slice(0, 90), datum: r.updated_at, uebertragenAm: u ? u.created_at : null };
      })
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
