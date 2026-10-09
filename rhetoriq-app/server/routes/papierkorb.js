// Papierkorb für gelöschte Klienten: anzeigen, wiederherstellen, sofort endgültig löschen. Nur Beraterin.
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const pk = require('../lib/papierkorb');

const router = express.Router();

router.get('/', requireAdvisor, async (req, res) => {
  try { res.json(await pk.liste(req.user.id)); }
  catch (e) { console.error('[papierkorb]', e.message); res.status(500).json({ error: 'Der Papierkorb konnte nicht geladen werden.' }); }
});

router.post('/:id/wiederherstellen', requireAdvisor, async (req, res) => {
  try {
    const r = await pk.wiederherstellen(parseInt(req.params.id, 10), req.user.id);
    if (!r) return res.status(404).json({ error: 'Dieser Klient liegt nicht im Papierkorb.' });
    res.json({ ok: true, name: r.name });
  } catch (e) { console.error('[papierkorb]', e.message); res.status(500).json({ error: 'Das Wiederherstellen hat nicht geklappt.' }); }
});

// Sofort und vollständig löschen (nur für Klienten, die schon im Papierkorb liegen)
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    if (req.query.confirm !== 'ja') return res.status(400).json({ error: 'Löschen bitte mit Bestätigung (confirm=ja) aufrufen.' });
    const id = parseInt(req.params.id, 10);
    const list = await pk.liste(req.user.id);
    if (!list.some(x => x.id === id)) return res.status(404).json({ error: 'Dieser Klient liegt nicht im Papierkorb.' });
    const r = await require('../lib/clientData').deleteClientCompletely(id, req.user.id);
    if (!r) return res.status(404).json({ error: 'Dieser Klient liegt nicht im Papierkorb.' });
    res.json({ ok: true, deleted: r.counts });
  } catch (e) { console.error('[papierkorb]', e.message); res.status(500).json({ error: 'Das Löschen hat nicht geklappt. Es wurde nichts verändert.' }); }
});

module.exports = router;
