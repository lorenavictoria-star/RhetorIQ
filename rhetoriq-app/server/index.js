require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const path = require('path');
const { init, pool } = require('./db');

const app = express();
const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

wss.broadcast = (data) => {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
};

app.locals.wss = wss;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── API Routes ────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/people', require('./routes/people'));
app.use('/api/memory', require('./routes/memory'));

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Serve Frontend ────────────────────────────────────────────
const FRONTEND = path.join(__dirname, '..', 'public');
app.use(express.static(FRONTEND));
app.get('*', (_, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// ── Seed Advisor Account ──────────────────────────────────────
async function seedAdvisor() {
  const email = process.env.ADVISOR_EMAIL;
  const password = process.env.ADVISOR_PASSWORD;
  const name = process.env.ADVISOR_NAME || 'Advisor';
  if (!email || !password) return;

  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length) return;

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)',
    [email, hash, name, 'advisor']
  );
  console.log(`✓ Advisor account created: ${email}`);
}

// ── Auto-cleanup: delete analyses older than RETENTION_DAYS ──
async function cleanupOldAnalyses() {
  const days = parseInt(process.env.RETENTION_DAYS || '30', 10);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM analyses WHERE created_at < NOW() - INTERVAL '${days} days'`
    );
    if (rowCount > 0) console.log(`Cleanup: deleted ${rowCount} analyses older than ${days} days`);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ── Boot ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

(async () => {
  await init();
  await seedAdvisor();
  await cleanupOldAnalyses();
  setInterval(cleanupOldAnalyses, 24 * 60 * 60 * 1000); // daily
  server.listen(PORT, () => console.log(`RhetorIQ server running on :${PORT}`));
})();
