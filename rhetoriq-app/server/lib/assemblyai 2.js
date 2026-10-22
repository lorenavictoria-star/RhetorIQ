// Dünne Anbindung an AssemblyAI (gleiches Muster wie routes/transcribe.js), mit Löschen des Transkripts nach dem Abruf.
// Tests ersetzen deps.request durch eine Attrappe.
const https = require('https');

function request(method, path, payload, buffer) {
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
    const req = https.request({ hostname: 'api.assemblyai.com', path, method, headers, timeout: 20000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Antwort nicht lesbar')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    if (buffer) req.write(buffer);
    req.end();
  });
}

const deps = { request, pollMs: 1000, maxWaitMs: 30000 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Audio hochladen, auf Deutsch transkribieren, Text abholen, Transkript bei AssemblyAI löschen. Wirft bei Fehlern.
async function transkribiere(buffer) {
  const up = await deps.request('POST', '/v2/upload', null, buffer);
  if (!up || !up.upload_url) throw new Error('Upload fehlgeschlagen');
  const job = await deps.request('POST', '/v2/transcript', { audio_url: up.upload_url, language_code: 'de' });
  if (!job || !job.id) throw new Error('Auftrag nicht angenommen');
  const id = job.id;
  try {
    const bis = Date.now() + deps.maxWaitMs;
    for (;;) {
      const r = await deps.request('GET', '/v2/transcript/' + id);
      if (r && r.status === 'completed') return String(r.text || '').trim();
      if (r && r.status === 'error') throw new Error(r.error || 'Transkription fehlgeschlagen');
      if (Date.now() > bis) throw new Error('Zeitüberschreitung');
      await sleep(deps.pollMs);
    }
  } finally {
    // Audio und Transkript bei AssemblyAI entfernen, auch bei Fehlern
    try { await deps.request('DELETE', '/v2/transcript/' + id); } catch (e) { console.error('[assistent] Transkript löschen fehlgeschlagen:', e.message); }
  }
}

module.exports = { transkribiere, deps };
