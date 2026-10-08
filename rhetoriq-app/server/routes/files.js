const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const { pool } = require('../db');
const { requireAuth, requireAdvisor } = require('../middleware/auth');
const { ensureSchema } = require('../lib/schemaRedesign');
const { saveFile, cleanName, FOLDERS, MAX_FILE_BYTES } = require('../lib/fileStore');

// Ablage (Dateien je Klient oder Entwurf).
//   GET    /api/files?client_id=|draft_id=[&folder=]   Liste ohne Inhalt
//   GET    /api/files/zip?client_id=|draft_id=         alles als ZIP
//   GET    /api/files/:id/download                     Datei laden
//   POST   /api/files                                  Upload (multipart "file" oder JSON mit base64)
//   DELETE /api/files/:id                              Beraterin: löschen
// Beraterin: alles. Eingeloggter Klient: nur die eigenen Dateien im Ordner 'unterlagen', nur lesend.
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|dll|sh|ps1|vbs|jar|apk|app|dmg)$/i;
const isAdvisor = req => req.user && req.user.role === 'advisor';
const parseId = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const LIST_COLS = 'id, client_id, draft_id, folder, name, mime, size, note, created_at';

// Bestimmt Zielbereich und Ordnerfilter nach Rolle. Liefert { where, params } oder { error, status }.
function scopeFor(req) {
  const folder = req.query.folder ? String(req.query.folder) : null;
  if (folder && !FOLDERS.includes(folder)) return { status: 400, error: 'Unbekannter Ordner.' };
  if (!isAdvisor(req)) {
    const own = req.user && req.user.clientId;
    if (req.user.role !== 'client' || !own) return { status: 403, error: 'Keine Berechtigung.' };
    const asked = req.query.client_id ? parseId(req.query.client_id) : own;
    if (asked !== Number(own) || req.query.draft_id) return { status: 403, error: 'Keine Berechtigung.' };
    if (folder && folder !== 'unterlagen') return { status: 403, error: 'Keine Berechtigung.' };
    return { where: `client_id=$1 AND folder='unterlagen'`, params: [own] };
  }
  const cid = req.query.client_id ? parseId(req.query.client_id) : null;
  const did = req.query.draft_id ? parseId(req.query.draft_id) : null;
  if (!cid && !did) return { status: 400, error: 'client_id oder draft_id erforderlich.' };
  const where = [cid ? 'client_id=$1' : 'draft_id=$1'];
  const params = [cid || did];
  if (folder) { where.push('folder=$2'); params.push(folder); }
  return { where: where.join(' AND '), params };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const sc = scopeFor(req);
    if (sc.error) return res.status(sc.status).json({ error: sc.error });
    const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM client_files WHERE ${sc.where} ORDER BY created_at DESC, id DESC LIMIT 500`, sc.params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/zip', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const sc = scopeFor(req);
    if (sc.error) return res.status(sc.status).json({ error: sc.error });
    const { rows } = await pool.query(
      `SELECT folder, name, data FROM client_files WHERE ${sc.where} ORDER BY folder, created_at, id LIMIT 500`, sc.params);
    const zip = new JSZip();
    const used = new Set();
    for (const f of rows) {
      let path = `${f.folder}/${cleanName(f.name)}`;
      for (let i = 2; used.has(path); i++) path = `${f.folder}/${i}_${cleanName(f.name)}`;
      used.add(path);
      zip.file(path, f.data || Buffer.alloc(0));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Ablage.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const { rows } = await pool.query('SELECT * FROM client_files WHERE id=$1', [id]);
    const f = rows[0];
    if (!f) return res.status(404).json({ error: 'Datei nicht gefunden.' });
    if (!isAdvisor(req)) {
      const own = req.user.role === 'client' && req.user.clientId;
      // Fremde oder nicht freigegebene Dateien werden wie nicht vorhanden behandelt.
      if (!own || f.client_id !== Number(own) || f.folder !== 'unterlagen') return res.status(404).json({ error: 'Datei nicht gefunden.' });
    }
    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.data || Buffer.alloc(0));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload: multipart (Feld "file") oder JSON {name, mime, dataBase64, ...}. JSON ist durch das 5-MB-Limit
// des Servers auf rund 3,5 MB Dateigrösse begrenzt; grössere Dateien über multipart (bis 10 MB).
function runUpload(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Datei ist grösser als 10 MB.' });
    return res.status(400).json({ error: 'Upload fehlgeschlagen.' });
  });
}

router.post('/', requireAdvisor, runUpload, async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    const folder = b.folder ? String(b.folder) : 'unterlagen';
    if (!FOLDERS.includes(folder)) return res.status(400).json({ error: 'Unbekannter Ordner.' });
    const clientId = b.client_id ? parseId(b.client_id) : null;
    const draftId = b.draft_id ? parseId(b.draft_id) : null;
    if (!clientId && !draftId) return res.status(400).json({ error: 'client_id oder draft_id erforderlich.' });
    let name, mime, buffer;
    if (req.file) {
      name = req.file.originalname; mime = req.file.mimetype; buffer = req.file.buffer;
    } else if (typeof b.dataBase64 === 'string' && b.name) {
      if (b.dataBase64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) return res.status(413).json({ error: 'Datei ist grösser als 10 MB.' });
      buffer = Buffer.from(b.dataBase64.replace(/^data:[^,]*,/, ''), 'base64');
      name = b.name; mime = b.mime;
    } else {
      return res.status(400).json({ error: 'Keine Datei übergeben.' });
    }
    name = cleanName(name);
    if (BLOCKED_EXT.test(name)) return res.status(400).json({ error: 'Dieser Dateityp ist nicht erlaubt.' });
    if (!buffer.length) return res.status(400).json({ error: 'Die Datei ist leer.' });
    if (buffer.length > MAX_FILE_BYTES) return res.status(413).json({ error: 'Datei ist grösser als 10 MB.' });
    if (clientId) {
      const c = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [clientId, req.user.id]);
      if (!c.rows.length) return res.status(404).json({ error: 'Klient nicht gefunden.' });
    }
    if (draftId) {
      const d = await pool.query('SELECT id FROM onboarding_drafts WHERE id=$1', [draftId]);
      if (!d.rows.length) return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
    }
    const file = await saveFile({ clientId, draftId, folder, name, mime, buffer, note: b.note });
    res.status(201).json(file);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige ID.' });
    const r = await pool.query('DELETE FROM client_files WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Datei nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
