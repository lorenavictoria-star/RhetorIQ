const express = require('express');
const multer = require('multer');
const https = require('https');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const router = express.Router();

function assemblyRequest(method, path, payload, buffer) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: process.env.ASSEMBLYAI_API_KEY };
    if (buffer) {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = buffer.length;
    } else if (payload) {
      const str = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(str);
      buffer = str;
    }
    const req = https.request({ hostname: 'api.assemblyai.com', path, method, headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(body)); } });
    });
    req.on('error', reject);
    if (buffer) req.write(buffer);
    req.end();
  });
}

// POST /api/transcribe — upload file, kick off job, return jobId
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!process.env.ASSEMBLYAI_API_KEY) return res.status(503).json({ error: 'ASSEMBLYAI_API_KEY not set' });
    const uploaded = await assemblyRequest('POST', '/v2/upload', null, req.file.buffer);
    const job = await assemblyRequest('POST', '/v2/transcript', { audio_url: uploaded.upload_url, language_detection: true });
    res.json({ jobId: job.id });
  } catch (e) {
    console.error('Transcribe submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/transcribe/:jobId — poll status
router.get('/:jobId', requireAuth, async (req, res) => {
  try {
    if (!process.env.ASSEMBLYAI_API_KEY) return res.status(503).json({ error: 'ASSEMBLYAI_API_KEY not set' });
    const result = await assemblyRequest('GET', '/v2/transcript/' + req.params.jobId);
    if (result.status === 'completed') return res.json({ status: 'done', text: result.text });
    if (result.status === 'error') return res.json({ status: 'error', error: result.error });
    res.json({ status: result.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
