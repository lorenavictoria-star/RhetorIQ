require('dotenv').config();

// Startup validation of required env vars
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY', 'ADVISOR_EMAIL', 'ADVISOR_PASSWORD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('FATAL: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// Optional but strongly recommended — warn (don't crash) if unset, since
// payments/monitoring degrade gracefully but silently without them.
const RECOMMENDED_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN'];
const missingRecommended = RECOMMENDED_ENV.filter(k => !process.env[k]);
if (missingRecommended.length) {
  console.warn('WARNING: Missing recommended environment variables (feature will be disabled):', missingRecommended.join(', '));
}

const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const morgan = require('morgan');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { init, pool } = require('./db');
const cron = require('node-cron');
const { runWeeklyReport }  = require('./jobs/weekly-report');
const { runMonthlyReport } = require('./jobs/monthly-report');

const app = express();

// ── Sentry (error tracking) ───────────────────────────────────
// @sentry/node v8+ auto-instruments express; no requestHandler/tracingHandler needed.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  });
  console.log('[sentry] Error tracking active');
}
const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  process.env.CORS_ORIGIN || 'https://rhetoriq.ch',
  'http://localhost:3000',
  'http://localhost:3001',
]);

const wss = new WebSocket.Server({ server, path: '/ws', noServer: false });

// Map of userId → Set of ws connections (for targeted sends)
const userSockets = new Map();

function wsAddClient(ws) {
  if (!userSockets.has(ws.userId)) userSockets.set(ws.userId, new Set());
  userSockets.get(ws.userId).add(ws);
}
function wsRemoveClient(ws) {
  const set = userSockets.get(ws.userId);
  if (set) { set.delete(ws); if (!set.size) userSockets.delete(ws.userId); }
}

wss.on('connection', (ws, req) => {
  // 1. Origin check — reject cross-origin connections
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    ws.close(4403, 'Forbidden');
    return;
  }

  // 2. Auth via first message (avoids token in URL / server logs)
  //    Client must send {type:'auth',token:'<JWT>'} within 5 s
  ws.isAuthenticated = false;
  const authTimeout = setTimeout(() => {
    if (!ws.isAuthenticated) ws.close(4401, 'Auth timeout');
  }, 5000);

  ws.on('message', async (raw) => {
    if (!ws.isAuthenticated) {
      // Expect auth handshake as first message
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== 'auth' || !msg.token) { ws.close(4401, 'Unauthorized'); return; }
        const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
        // Honor server-side revocation (token_version) here too, so a
        // revoked client/advisor can't keep receiving live pushes.
        const table = decoded.role === 'advisor' ? 'users' : (decoded.clientUserId ? 'client_users' : 'clients');
        const id = decoded.role === 'advisor' ? decoded.id : (decoded.clientUserId || decoded.clientId);
        const { rows } = await pool.query(`SELECT token_version FROM ${table} WHERE id=$1`, [id]);
        if (!rows.length || (decoded.tokenVersion || 1) !== rows[0].token_version) {
          ws.close(4401, 'Unauthorized'); return;
        }
        ws.userId = String(decoded.id || decoded.clientId);
        ws.isAuthenticated = true;
        clearTimeout(authTimeout);
        wsAddClient(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      } catch {
        ws.close(4401, 'Unauthorized');
      }
      return;
    }
    // Authenticated — ignore further client messages (read-only push channel)
  });

  // 3. Heartbeat — ping every 30 s, close if no pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => { if (ws.isAuthenticated) wsRemoveClient(ws); clearTimeout(authTimeout); });
  ws.on('error', () => { if (ws.isAuthenticated) wsRemoveClient(ws); clearTimeout(authTimeout); });
});

// Ping all connections every 30 s — remove dead ones
const wsPingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(wsPingInterval));

// Broadcast to all authenticated clients (or targeted by userId)
wss.broadcast = (data, targetUserId = null) => {
  const msg = JSON.stringify(data);
  if (targetUserId) {
    const sockets = userSockets.get(String(targetUserId));
    if (sockets) sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  } else {
    userSockets.forEach(sockets =>
      sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); })
    );
  }
};

app.locals.wss = wss;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://rhetoriq.ch', credentials: true }));
// Webhook needs raw body — must be registered before express.json()
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));

// Structured request logging: timestamp · method · path · status · duration
app.use(morgan(':date[iso] :method :url :status :res[content-length]b :response-time ms'));
// Security headers. CSP is disabled: the frontend is a single-file app that
// relies on one large inline <script> block and inline onclick="" handlers
// throughout — helmet's default Content-Security-Policy (script-src 'self',
// script-src-attr 'none') silently blocks all of that, breaking the entire
// app including login. The other helmet protections (X-Frame-Options,
// X-Content-Type-Options, HSTS, etc.) still apply.
app.use(require('helmet')({ contentSecurityPolicy: false }));

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
    // IPv6 addresses must go through ipKeyGenerator (subnet-masked), not the
    // raw address — a single IPv6 client can trivially rotate through its
    // /64 subnet, otherwise letting them bypass this limiter entirely.
    return ipKeyGenerator(req.ip);
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
app.use('/api/setup', require('./routes/setup'));

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

// ── Sentry error handler (must be before generic error handler) ──
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Generic error handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.url} —`, err.message);
  res.status(500).json({ error: 'Internal server error' });
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

  const hash = await bcrypt.hash(password, 12);
  // UPSERT: insert if not exists, update password if exists
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) ' +
    'ON CONFLICT (email) DO UPDATE SET password_hash = $2, name = $3',
    [email, hash, name, 'advisor']
  );
  console.log(`✓ Advisor account ready: ${email}`);
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
