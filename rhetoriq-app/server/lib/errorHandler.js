// Zentrale Fehlerbehandlung (Befund F-08): Upload-Grenzen als 413, zu grosse oder ungültige Anfragen, sonst 500.
function errorHandler(err, req, res, _next) {
  console.error(`[error] ${req.method} ${req.url} —`, require('./scrub').scrubText(err && err.type === 'entity.parse.failed' ? 'Ungültiger Anfragekörper' : err && err.message));
  if (res.headersSent) return;
  if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
    return res.status(413).json({ error: 'Die Datei ist zu gross oder es sind zu viele Dateien (höchstens 5 Dateien, je 15 MB).' });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Die Anfrage ist zu gross.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage.' });
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
