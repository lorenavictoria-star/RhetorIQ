// Stimmenmappe und Handbuch als Word, ZIP über alle Klienten. Nur für die Beraterin, ohne KI.
const express = require('express');
const { requireAdvisor } = require('../middleware/auth');
const { ownClient } = require('../middleware/ownership');
const { pool } = require('../db');
const sm = require('../lib/stimmenmappe');

const router = express.Router();
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function nameOf(id) {
  const { rows } = await pool.query('SELECT name FROM clients WHERE id=$1', [id]);
  return rows[0] ? sm.safeName(rows[0].name) : 'Klient';
}
function send(res, buf, filename, type) {
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(buf);
}

// Muss vor den Pfaden mit :clientId stehen
router.get('/alle.zip', requireAdvisor, async (req, res) => {
  try {
    const { buffer } = await sm.buildZip(req.user.id);
    send(res, buffer, `Stimmenmappen_${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
  } catch (e) {
    console.error('[stimmenmappe] ZIP:', e.message);
    res.status(500).json({ error: 'Die Stimmenmappen konnten nicht erstellt werden.' });
  }
});

router.get('/:clientId/handbuch.docx', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const buf = await sm.buildHandbuch(parseInt(req.params.clientId, 10));
    send(res, buf, `Handbuch_${await nameOf(req.params.clientId)}.docx`, DOCX);
  } catch (e) {
    console.error('[stimmenmappe] Handbuch:', e.message);
    res.status(500).json({ error: 'Das Handbuch konnte nicht erstellt werden.' });
  }
});

router.get('/:clientId.docx', requireAdvisor, ownClient('clientId'), async (req, res) => {
  try {
    const buf = await sm.buildMappe(parseInt(req.params.clientId, 10));
    send(res, buf, `Stimmenmappe_${await nameOf(req.params.clientId)}.docx`, DOCX);
  } catch (e) {
    console.error('[stimmenmappe] Mappe:', e.message);
    res.status(500).json({ error: 'Die Stimmenmappe konnte nicht erstellt werden.' });
  }
});

module.exports = router;
