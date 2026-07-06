const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/module-prompts/:clientId/:moduleKey
router.get('/:clientId/:moduleKey', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, moduleKey } = req.params;
  const { rows } = await pool.query(
    'SELECT instructions FROM client_module_prompts WHERE client_id=$1 AND module_key=$2',
    [clientId, moduleKey]
  );
  res.json({ instructions: rows[0]?.instructions || '' });
});

// POST /api/module-prompts/:clientId/:moduleKey
router.post('/:clientId/:moduleKey', requireAuth, async (req, res) => {
  if (req.user.role !== 'advisor') return res.status(403).json({ error: 'Forbidden' });
  const { clientId, moduleKey } = req.params;
  const { instructions } = req.body;
  await pool.query(
    `INSERT INTO client_module_prompts (client_id, module_key, instructions, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (client_id, module_key) DO UPDATE SET instructions=$3, updated_at=NOW()`,
    [clientId, moduleKey, instructions]
  );
  res.json({ ok: true });
});

module.exports = router;
