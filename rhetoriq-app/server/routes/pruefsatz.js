const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient, canAccessClient } = require('../middleware/ownership');
const ps = require('../lib/pruefsatz');

const router = express.Router();
const fail = (res, e) => {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  console.error('[pruefsatz]', e && e.message); res.status(500).json({ error: 'Internal server error' });
};

// GET /api/pruefsatz/vorschau/:clientId  Briefings und geschätzte Obergrenze der Kosten (ohne KI-Aufruf)
router.get('/vorschau/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { res.json(await ps.vorschau(Number(req.params.clientId))); } catch (e) { fail(res, e); }
});

// POST /api/pruefsatz/start  { clientId, bestaetigt: true }  startet den Lauf im Hintergrund
router.post('/start', requireAdvisor, async (req, res) => {
  try {
    const clientId = parseInt(req.body && req.body.clientId, 10);
    if (!Number.isInteger(clientId) || !(await canAccessClient(req, clientId))) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    if (!req.body || req.body.bestaetigt !== true) return res.status(400).json({ error: 'Der Lauf startet nur nach ausdrücklicher Bestätigung der Kosten.' });
    const id = await ps.starten({ clientId, advisorId: req.user.id, authorization: req.headers.authorization });
    res.status(202).json({ id });
  } catch (e) { fail(res, e); }
});

async function eigenerLauf(req, res) {
  const row = await ps.laden(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Nicht gefunden.' }); return null; }
  if (!(await canAccessClient(req, row.client_id))) { res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' }); return null; }
  return row;
}

// GET /api/pruefsatz/lauf/:id  Stand (Fortschritt, Texte in gemischter Reihenfolge, Auswertung erst nach der letzten Wahl)
router.get('/lauf/:id(\\d+)', requireAdvisor, async (req, res) => {
  try { const row = await eigenerLauf(req, res); if (row) res.json(ps.ansicht(row)); } catch (e) { fail(res, e); }
});

// POST /api/pruefsatz/lauf/:id/wahl  { nr, wahl: 0 | 1 | ... | 'gleich' }
router.post('/lauf/:id(\\d+)/wahl', requireAdvisor, async (req, res) => {
  try { const row = await eigenerLauf(req, res); if (row) res.json(await ps.waehlen(row.id, req.body && req.body.nr, req.body && req.body.wahl)); } catch (e) { fail(res, e); }
});

// GET /api/pruefsatz/liste/:clientId  frühere Läufe
router.get('/liste/:clientId', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try { res.json({ laeufe: await ps.liste(Number(req.params.clientId)) }); } catch (e) { fail(res, e); }
});

module.exports = router;
