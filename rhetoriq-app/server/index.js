require('dotenv').config();

// FIX 10: Startup validation of required env vars
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('FATAL: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { init, pool } = require('./db');
const cron = require('node-cron');
const { runWeeklyReport }  = require('./jobs/weekly-report');
const { runMonthlyReport } = require('./jobs/monthly-report');

const app = express();
const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

// FIX 8: WebSocket auth — client must pass ?token=JWT in the URL
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) { ws.close(4401, 'Unauthorized'); return; }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    ws.userId = decoded.id || decoded.clientId;
  } catch {
    ws.close(4401, 'Unauthorized');
    return;
  }
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
// FIX 6: Restrict CORS to known frontend origin
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://rhetoriq.ch', credentials: true }));
app.use(express.json({ limit: '2mb' }));
// FIX 11: helmet security headers (npm install helmet if not yet installed)
try { app.use(require('helmet')()); } catch { console.warn('helmet not installed — run: npm install helmet'); }

// ── Rate Limiting ─────────────────────────────────────────────
// General API: 200 requests / 15 min per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte in einigen Minuten erneut versuchen.' }
}));

// Analyze (Claude calls): 30 / 15 min per IP — prevents runaway costs
app.use('/api/analyze', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generierungslimit erreicht (30 pro 15 Min.). Bitte kurz warten.' }
}));

// Auth endpoints: 20 / 15 min — brute-force protection
app.use('/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' }
}));

// Per-user analyze limiter: 30 / 1 min per authenticated user (keyed on JWT user ID)
const userAnalyzeLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    try {
      const token = req.headers.authorization?.split(' ')[1] || req.query.token;
      if (token) {
        const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
        return `user_${decoded.id || decoded.clientId}`;
      }
    } catch {}
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});
app.use('/api/analyze', userAnalyzeLimit);

// ── API Routes ────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/people', require('./routes/people'));
app.use('/api/memory', require('./routes/memory'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/klaviyo', require('./routes/klaviyo'));
app.use('/api/advisor', require('./routes/advisor'));
app.use('/api/fetch-website', require('./routes/fetchWebsite'));
app.use('/api/transcribe', require('./routes/transcribe'));
app.use('/api/onboard', require('./routes/onboard'));
app.use('/api/custom-modules', require('./routes/customModules'));
app.use('/api/module-examples', require('./routes/moduleExamples'));
app.use('/api/module-prompts', require('./routes/modulePrompts'));

// Manual report trigger (advisor only)
const { requireAdvisor } = require('./middleware/auth');
app.post('/api/admin/report/weekly',  requireAdvisor, async (req, res) => {
  runWeeklyReport().catch(e => console.error(e));
  res.json({ ok: true, message: 'Weekly report triggered — arrives by email in ~30s' });
});
app.post('/api/admin/report/monthly', requireAdvisor, async (req, res) => {
  runMonthlyReport().catch(e => console.error(e));
  res.json({ ok: true, message: 'Monthly report triggered — arrives by email in ~30s' });
});
app.use('/api/audit', require('./routes/audit'));

// FIX 9: Health check with DB probe
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'disconnected', error: e.message });
  }
});

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

// ── Boot ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

(async () => {
  await init();
  await seedAdvisor();
  server.listen(PORT, () => console.log(`RhetorIQ server running on :${PORT}`));

  // ── Scheduled reports ──────────────────────────────────────────
  // Weekly: every Monday at 08:03 (off-minute to avoid fleet collisions)
  cron.schedule('3 8 * * 1', () => runWeeklyReport(), { timezone: 'Europe/Zurich' });

  // Monthly: 1st of each month at 08:07
  cron.schedule('7 8 1 * *', () => runMonthlyReport(), { timezone: 'Europe/Zurich' });

  console.log('[cron] Weekly report: every Monday 08:03 Zurich');
  console.log('[cron] Monthly report: 1st of month 08:07 Zurich');
})();

function gracefulShutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
