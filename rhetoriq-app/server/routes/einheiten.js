// /api/einheiten: Restaurants (Betriebe) eines Klienten mit eigenem Stimmprofil und eigenen Fakten.
//   GET    /?clientId=X       Liste (Klienten sehen nur die eigenen)
//   POST   /                  anlegen { clientId, name, ort?, stimme?, fakten? }
//   POST   /bulk              mehrere auf einmal { clientId, zeilen: "Name, Ort\nName, Ort" }
//   PUT    /:id               ändern
//   DELETE /:id               löschen
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { allowedClientId, canAccessClient } = require('../middleware/ownership');
const { ensureSchema } = require('../lib/schemaRedesign');

const router = express.Router();
const MAX_PRO_KLIENT = 100;
const NAME_MAX = 120, ORT_MAX = 120, TEXT_MAX = 8000;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function eigene(req, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  const { rows } = await pool.query('SELECT * FROM einheiten WHERE id=$1', [n]);
  if (!rows[0]) return null;
  return (await canAccessClient(req, rows[0].client_id)) ? rows[0] : null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const clientId = await allowedClientId(req, req.query.clientId);
    if (!clientId) return res.json([]);
    const { rows } = await pool.query('SELECT id, client_id, name, ort, stimme, fakten, updated_at FROM einheiten WHERE client_id=$1 ORDER BY LOWER(name)', [clientId]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireAuth, requireRole('editor'), async (req, res) => {
  try {
    await ensureSchema();
    const clientId = await allowedClientId(req, req.body && req.body.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    const name = text(req.body.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen eintragen.' });
    const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM einheiten WHERE client_id=$1', [clientId]);
    if (cnt[0].n >= MAX_PRO_KLIENT) return res.status(400).json({ error: 'Höchstens ' + MAX_PRO_KLIENT + ' Restaurants pro Kunde.' });
    const { rows } = await pool.query(
      'INSERT INTO einheiten (client_id, name, ort, stimme, fakten) VALUES ($1,$2,$3,$4,$5) RETURNING id, client_id, name, ort, stimme, fakten, updated_at',
      [clientId, name, text(req.body.ort, ORT_MAX), text(req.body.stimme, TEXT_MAX), text(req.body.fakten, TEXT_MAX)]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mehrere auf einmal: eine Zeile pro Restaurant, «Name, Ort» oder nur «Name»
router.post('/bulk', requireAuth, requireRole('editor'), async (req, res) => {
  try {
    await ensureSchema();
    const clientId = await allowedClientId(req, req.body && req.body.clientId);
    if (!clientId) return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    const zeilen = String(req.body.zeilen || '').split(/\r?\n/).map(z => z.trim()).filter(Boolean);
    if (!zeilen.length) return res.status(400).json({ error: 'Bitte mindestens eine Zeile eintragen.' });
    const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM einheiten WHERE client_id=$1', [clientId]);
    if (cnt[0].n + zeilen.length > MAX_PRO_KLIENT) return res.status(400).json({ error: 'Höchstens ' + MAX_PRO_KLIENT + ' Restaurants pro Kunde.' });
    const neu = [];
    for (const z of zeilen) {
      const i = z.search(/[,;\t]/);
      const name = text(i < 0 ? z : z.slice(0, i), NAME_MAX);
      const ort = i < 0 ? '' : text(z.slice(i + 1), ORT_MAX);
      if (!name) continue;
      const { rows } = await pool.query('INSERT INTO einheiten (client_id, name, ort) VALUES ($1,$2,$3) RETURNING id, client_id, name, ort, stimme, fakten, updated_at', [clientId, name, ort]);
      neu.push(rows[0]);
    }
    res.status(201).json({ angelegt: neu.length, einheiten: neu });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAuth, requireRole('editor'), async (req, res) => {
  try {
    const e0 = await eigene(req, req.params.id);
    if (!e0) return res.status(403).json({ error: 'Kein Zugriff auf dieses Restaurant.' });
    const b = req.body || {};
    const name = b.name !== undefined ? text(b.name, NAME_MAX) : e0.name;
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen eintragen.' });
    const { rows } = await pool.query(
      'UPDATE einheiten SET name=$1, ort=$2, stimme=$3, fakten=$4, updated_at=NOW() WHERE id=$5 RETURNING id, client_id, name, ort, stimme, fakten, updated_at',
      [name, b.ort !== undefined ? text(b.ort, ORT_MAX) : e0.ort, b.stimme !== undefined ? text(b.stimme, TEXT_MAX) : e0.stimme, b.fakten !== undefined ? text(b.fakten, TEXT_MAX) : e0.fakten, e0.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAuth, requireRole('editor'), async (req, res) => {
  try {
    const e0 = await eigene(req, req.params.id);
    if (!e0) return res.status(403).json({ error: 'Kein Zugriff auf dieses Restaurant.' });
    await pool.query('DELETE FROM einheiten WHERE id=$1', [e0.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
