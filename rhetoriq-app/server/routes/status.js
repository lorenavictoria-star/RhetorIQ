// Öffentlicher Zustand der KI und Schalter der Beraterin (ohne Deploy).
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { getStatus, setStatus } = require('../lib/systemStatus');

const router = express.Router();

// Ohne Anmeldung, keine Details: nur ok oder gestoert (plus Text, den die Beraterin selbst gesetzt hat)
router.get('/', async (req, res) => {
  const auto = (await getStatus('ki_stoerung', false)) === true;
  const man = await getStatus('hinweis_manuell', null);
  const manuell = !!(man && man.an);
  const out = { ki: auto || manuell ? 'gestoert' : 'ok' };
  if (manuell && man.text) out.hinweis = String(man.text).slice(0, 500);
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

router.get('/manuell', requireAdvisor, async (req, res) => {
  const w = await getStatus('hinweis_manuell', { an: false, text: '' });
  const wd = await getStatus('ki_waechter', null);
  res.json({ ...w, waechter: wd ? { fails: wd.fails, stoerung: wd.stoerung, lastOk: wd.lastOk, lastFail: wd.lastFail } : null });
});

router.put('/manuell', requireAdvisor, async (req, res) => {
  const an = req.body && req.body.an === true;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  await setStatus('hinweis_manuell', { an, text });
  res.json({ ok: true, an, text });
});

module.exports = router;
