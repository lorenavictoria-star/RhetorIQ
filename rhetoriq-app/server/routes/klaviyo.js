const express = require('express');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ownClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');
const kl = require('../lib/klaviyoApi');
const store = require('../lib/klaviyoStore');
const secretBox = require('../lib/secretBox');
const { baueHtml } = require('../lib/newsletterHtml');
const { scrubText } = require('../lib/scrub');

const router = express.Router();

// Der private Schlüssel kommt nur in Anfragekörpern an (PUT /schluessel, POST /templates, /draft), nie in der URL.
// Er wird weder zurückgegeben noch geloggt. Fehler laufen durch scrubText.

function nichtNurLesend(req, res, next) {
  if (req.user && req.user.readOnly) return res.status(403).json({ error: 'In dieser Ansicht lässt sich nichts ändern.' });
  next();
}

function fehler(res, e, du) {
  if (e instanceof kl.KlaviyoFehler) {
    const status = e.code === 'limit' ? 429 : (e.code === 'server' || e.code === 'netz') ? 502 : 400;
    return res.status(status).json({ error: e.message, klaviyo: e.code });
  }
  console.error('[klaviyo]', scrubText(e && e.message));
  return res.status(500).json({ error: 'Internal server error' });
}

function nichtEingerichtet(res, du) {
  return res.status(503).json({
    nichtEingerichtet: true,
    error: du
      ? 'Die verschlüsselte Ablage ist noch nicht eingerichtet. Setze SECRETS_ENCRYPTION_KEY in Render, dann lässt sich der Schlüssel speichern.'
      : 'Die sichere Ablage für den Schlüssel ist noch nicht eingerichtet. Bitte melden Sie sich bei Lorena.'
  });
}

// Gemeinsames Speichern nach Prüfung (Format, Gültigkeit, Rechte). Gibt true, wenn die Antwort schon gesendet ist.
async function speichereGeprueft(res, kind, id, rawKey, du) {
  if (!secretBox.available()) { nichtEingerichtet(res, du); return; }
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!kl.formatOk(apiKey)) return res.status(400).json({ error: kl.texte(du).format });
  let p;
  try { p = await kl.pruefe(apiKey, { du }); } catch (e) { return fehler(res, e, du); }
  if (!p.gueltig) return res.status(400).json({ error: kl.texte(du).ungueltig, klaviyo: 'ungueltig' });
  try { await store.speichere(kind, id, apiKey, p.rechte); }
  catch (e) {
    if (e && e.code === 'NO_SECRET') return nichtEingerichtet(res, du);
    console.error('[klaviyo] speichern:', scrubText(e && e.message));
    return res.status(500).json({ error: 'Internal server error' });
  }
  const fehlend = Object.entries(p.rechte).filter(([, v]) => !v).map(([k]) => ({ vorlagen: 'Templates', listen: 'Lists', kampagnen: 'Campaigns' }[k]));
  return res.json({ ok: true, verbunden: true, rechte: p.rechte, hinweis: fehlend.length ? `Verbunden. Dem Schlüssel fehlen noch Rechte für: ${fehlend.join(', ')}.` : 'Verbunden.' });
}

// ── Beraterin ────────────────────────────────────────────────────────────────
router.get('/berater/status', requireAdvisor, async (req, res) => {
  try { res.json(await store.status('advisor', req.user.id)); } catch (e) { return fehler(res, e, true); }
});
router.put('/berater/schluessel', requireAdvisor, async (req, res) => {
  try { await speichereGeprueft(res, 'advisor', req.user.id, req.body && req.body.apiKey, true); } catch (e) { return fehler(res, e, true); }
});
router.delete('/berater/schluessel', requireAdvisor, async (req, res) => {
  try { await store.loesche('advisor', req.user.id); res.json({ ok: true, verbunden: false }); } catch (e) { return fehler(res, e, true); }
});

async function beraterKey(req) {
  const given = req.body && typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
  return given || await store.lade('advisor', req.user.id);
}

// POST /api/klaviyo/templates: vorhandene Vorlagen laden. Ohne apiKey im Körper gilt der gespeicherte Schlüssel der Beraterin.
// (POST mit Körper, damit der Schlüssel nie in einer URL oder einem Zugriffsprotokoll landet)
router.post('/templates', requireAdvisor, async (req, res) => {
  try {
    const apiKey = await beraterKey(req);
    if (!apiKey) return res.status(400).json({ error: 'Es ist noch kein Klaviyo-Schlüssel verbunden.' });
    res.json({ templates: await kl.vorlagen(apiKey, { du: true }) });
  } catch (e) { return fehler(res, e, true); }
});

// POST /api/klaviyo/draft: Newsletter-Text als Vorlage in Klaviyo anlegen (kein Versand)
router.post('/draft', requireAdvisor, async (req, res) => {
  try {
    const content = req.body && req.body.content;
    const subject = req.body && req.body.subject;
    const apiKey = await beraterKey(req);
    if (!apiKey || !content) return res.status(400).json({ error: 'Schlüssel und Text sind nötig.' });
    const h = baueHtml(String(content), {});
    const betreff = String(subject || h.betreff || 'RhetorIQ Entwurf').slice(0, 120);
    const name = `${betreff} (RhetorIQ ${new Date().toLocaleDateString('de-CH')})`;
    const id = await kl.legeVorlageAn(apiKey, name, h.html, { du: true });
    res.json({ ok: true, templateId: id, templateName: name });
  } catch (e) { return fehler(res, e, true); }
});

// ── Klient (Hauptzugang, Rolle admin oder editor) ─────────────────────────────
router.get('/status/:clientId', requireAuth, ownClient('clientId'), async (req, res) => {
  try { res.json(await store.status('client', Number(req.params.clientId))); } catch (e) { return fehler(res, e, req.user.role === 'advisor'); }
});

router.put('/schluessel/:clientId', requireAuth, requireRole('admin'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try { await speichereGeprueft(res, 'client', Number(req.params.clientId), req.body && req.body.apiKey, req.user.role === 'advisor'); }
  catch (e) { return fehler(res, e, req.user.role === 'advisor'); }
});

router.delete('/schluessel/:clientId', requireAuth, requireRole('admin'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  try { await store.loesche('client', Number(req.params.clientId)); res.json({ ok: true, verbunden: false }); }
  catch (e) { return fehler(res, e, req.user.role === 'advisor'); }
});

router.post('/pruefen/:clientId', requireAuth, requireRole('admin'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  const du = req.user.role === 'advisor';
  try {
    const id = Number(req.params.clientId);
    const key = await store.lade('client', id);
    if (!key) return res.json({ verbunden: false, meldung: 'Es ist kein Klaviyo-Schlüssel verbunden.' });
    const p = await kl.pruefe(key, { du });
    if (!p.gueltig) return res.json({ verbunden: false, ungueltig: true, meldung: kl.texte(du).ungueltig });
    await store.aktualisiereRechte('client', id, p.rechte);
    const fehlend = Object.entries(p.rechte).filter(([, v]) => !v).map(([k]) => ({ vorlagen: 'Templates', listen: 'Lists', kampagnen: 'Campaigns' }[k]));
    res.json({ verbunden: true, rechte: p.rechte, meldung: fehlend.length ? `Die Verbindung steht. Dem Schlüssel fehlen Rechte für: ${fehlend.join(', ')}.` : 'Die Verbindung steht und alle Rechte sind vorhanden.' });
  } catch (e) { return fehler(res, e, du); }
});

router.get('/listen/:clientId', requireAuth, requireRole('editor'), ownClient('clientId'), async (req, res) => {
  const du = req.user.role === 'advisor';
  try {
    const key = await store.lade('client', Number(req.params.clientId));
    if (!key) return res.status(409).json({ nichtVerbunden: true, error: 'Klaviyo ist noch nicht verbunden.' });
    res.json({ listen: await kl.listen(key, { du }) });
  } catch (e) { return fehler(res, e, du); }
});

const NEWSLETTER_SQL = `(module_tile='newsletter' OR LOWER(COALESCE(module_label,'')) LIKE '%newsletter%')`;

// POST /api/klaviyo/senden/:clientId { reviewId, kampagne?: { listId, absenderEmail, absenderName } }
// Legt den freigegebenen Newsletter als HTML-Vorlage und auf Wunsch als Kampagnenentwurf an. Es wird NIE versendet.
router.post('/senden/:clientId', requireAuth, requireRole('editor'), nichtNurLesend, ownClient('clientId'), async (req, res) => {
  const du = req.user.role === 'advisor';
  try {
    await ensureSchema();
    const clientId = Number(req.params.clientId);
    const reviewId = parseInt(req.body && req.body.reviewId, 10);
    if (!Number.isInteger(reviewId) || reviewId < 1) return res.status(400).json({ error: 'Bitte wählen Sie einen freigegebenen Newsletter.' });
    const rv = (await pool.query(`SELECT id, edited_text, original_text, status FROM review_requests WHERE id=$1 AND client_id=$2 AND ${NEWSLETTER_SQL}`, [reviewId, clientId])).rows[0];
    if (!rv) return res.status(404).json({ error: 'Newsletter nicht gefunden.' });
    if (rv.status !== 'approved') return res.status(409).json({ error: 'Dieser Newsletter ist noch nicht freigegeben. Er lässt sich erst nach der Freigabe durch die Beraterin übertragen.' });
    const key = await store.lade('client', clientId);
    if (!key) return res.status(409).json({ nichtVerbunden: true, error: 'Klaviyo ist noch nicht verbunden. Die Admin-Person Ihres Unternehmens trägt den Schlüssel unter «Abo verwalten» ein.' });
    const text = rv.edited_text || rv.original_text;
    const h = baueHtml(text, {});
    const betreff = h.betreff || 'Newsletter';
    const name = `${betreff.slice(0, 110)} (RhetorIQ ${new Date().toLocaleDateString('de-CH')})`;
    const out = { ok: true, vorlageName: name };
    out.vorlageId = await kl.legeVorlageAn(key, name, h.html, { du });
    const k = req.body && req.body.kampagne;
    if (k && typeof k === 'object') {
      const listId = String(k.listId || '').trim(), mail = String(k.absenderEmail || '').trim();
      if (!/^[A-Za-z0-9]{3,30}$/.test(listId) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(mail)) {
        out.kampagneFehler = 'Für den Kampagnenentwurf braucht es eine Liste und eine gültige Absenderadresse. Die Vorlage ist angelegt.';
      } else {
        try {
          const c = await kl.legeKampagnenentwurfAn(key, { name, listId, betreff, vorschau: h.vorschau, absenderEmail: mail, absenderName: String(k.absenderName || '').slice(0, 100), vorlageId: out.vorlageId }, { du });
          out.kampagneId = c.kampagneId;
        } catch (e) {
          if (!(e instanceof kl.KlaviyoFehler)) throw e;
          out.kampagneFehler = `Der Kampagnenentwurf konnte nicht angelegt werden: ${e.message} Die Vorlage ist angelegt.`;
        }
      }
    }
    await pool.query('INSERT INTO klaviyo_uebertragungen (client_id, review_id, vorlage_id, kampagne_id) VALUES ($1,$2,$3,$4)', [clientId, reviewId, out.vorlageId || null, out.kampagneId || null]);
    out.hinweis = (out.kampagneId ? 'In Klaviyo liegen jetzt eine Vorlage und ein Kampagnenentwurf. ' : 'In Klaviyo liegt jetzt eine Vorlage. ') + 'Es wurde nichts versendet. Den Versand lösen Sie in Klaviyo selbst aus.';
    res.json(out);
  } catch (e) { return fehler(res, e, du); }
});

module.exports = router;
