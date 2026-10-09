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
require('./lib/asyncErrors'); // vor dem Laden der Routen: Fehler in async-Routen landen im Fehlerbehandler
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
const { runWeeklyReport, ensureRecentWeeklyReport } = require('./jobs/weekly-report');
const { runMonthlyReport } = require('./jobs/monthly-report');
const { sweepOutbox } = require('./lib/emailOutbox');

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

const wss = new WebSocket.Server({ server, path: '/ws', noServer: false, maxPayload: 4096 });

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
        // Schlüssel mit Rolle, damit eine Klienten-Nummer nie mit einer Berater-Nummer verwechselt wird
        ws.userId = decoded.role === 'advisor' ? 'adv:' + decoded.id : 'cli:' + decoded.clientId;
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

// Gezielte Meldungen: nur an die Beraterin bzw. nur an den betroffenen Klienten. wss.broadcast (an alle)
// wird nicht mehr für Inhalte verwendet.
function wsSendToKeys(pred, data) {
  const msg = JSON.stringify(data);
  userSockets.forEach((sockets, key) => {
    if (!pred(key)) return;
    sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  });
}
wss.toAdvisors = (data) => wsSendToKeys(k => k.startsWith('adv:'), data);
wss.toAdvisor = (advisorId, data) => wsSendToKeys(k => k === 'adv:' + advisorId, data);
wss.toClient = (clientId, data) => { if (clientId != null) wsSendToKeys(k => k === 'cli:' + clientId, data); };

app.locals.wss = wss;

// ── Middleware ────────────────────────────────────────────────
// Hinter dem Render-Proxy: sonst sehen alle Anfragen wie dieselbe Adresse aus, und alle Nutzer teilen sich die Anfrage-Limits.
app.set('trust proxy', 1);
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
const analyzeGenLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generierungslimit erreicht (30 pro 15 Min.). Bitte kurz warten.' }
});
// Das strenge Limit gilt nur für Aufrufe, die etwas erzeugen. Lesen (Zähler, Verlauf, Nutzung) verbraucht es nicht.
app.use('/api/analyze', (req, res, next) => (req.method === 'GET' ? next() : analyzeGenLimit(req, res, next)));

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
app.use('/api/analyze', (req, res, next) => (req.method === 'GET' ? next() : userAnalyzeLimit(req, res, next)));

// Ansicht des Klienten: Tokens mit readOnly:true dürfen nur lesen (alle anderen Tokens unverändert).
app.use(require('./middleware/readOnly').readOnlyGuard);

// ── API Routes ────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/clients', require('./routes/clientStats'));
app.use('/api/clients', require('./routes/kiHinweis'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/people', require('./routes/people'));
app.use('/api/memory', require('./routes/memory'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/klaviyo', require('./routes/klaviyo'));
app.use('/api/advisor', require('./routes/advisor'));
app.use('/api/advisor', require('./routes/viewAs'));
app.use('/api/fetch-website', require('./routes/fetchWebsite'));
app.use('/api/transcribe', require('./routes/transcribe'));
app.use('/api/onboard', require('./routes/onboard'));
app.use('/api/custom-modules', require('./routes/customModules'));
app.use('/api/module-examples', require('./routes/moduleExamples'));
app.use('/api/module-prompts', require('./routes/modulePrompts'));
app.use('/api/setup', require('./routes/setup'));
const inquiries = require('./routes/inquiries');
app.use('/api/inquiry', inquiries.publicRouter);
app.use('/api/inquiries', inquiries.advisorRouter);
app.use('/api/schnelltest', require('./routes/schnelltest'));
app.use('/api/onboarding-drafts', require('./routes/onboardingDrafts'));
app.use('/api/files', require('./routes/files'));
app.use('/api/help-chat', require('./routes/helpChat'));
app.use('/api/memory-suggest', require('./routes/memorySuggest'));
app.use('/api/learning', require('./routes/learning'));
app.use('/api/comm-profile', require('./routes/commProfile'));
app.use('/api/lernkurve', require('./routes/lernkurve'));
app.use('/api/stimmnaehe', require('./routes/stimmnaehe'));
app.use('/api/messung', require('./routes/messung'));
app.use('/api/pruefsatz', require('./routes/pruefsatz'));
app.use('/api/client-plan', require('./routes/clientPlan'));
app.use('/api/review-time', require('./routes/reviewTime'));
app.use('/api/archive', require('./routes/archive'));
app.use('/api/quartalsreview', require('./routes/quartalsreview'));
app.use('/api/status', require('./routes/status'));
app.use('/api/stimmenmappe', require('./routes/stimmenmappe'));

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

// Visibility into the email outbox (feedback, "an Beraterin senden", reports):
// so a failure is something you can check and re-trigger yourself, not a
// silent gap you only discover when a client mentions it weeks later.
app.get('/api/admin/email-outbox', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, kind, to_email, subject, status, attempts, last_error, created_at, sent_at
       FROM email_outbox ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.post('/api/admin/email-outbox/:id/retry', requireAdvisor, async (req, res) => {
  try {
    const { attemptSend } = require('./lib/emailOutbox');
    await attemptSend(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.use('/api/audit', require('./routes/audit'));


// FIX 9: Health check with DB probe
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    console.error('[health] Datenbank nicht erreichbar:', e.message);
    res.status(503).json({ ok: false, db: 'disconnected' });
  }
});

// ── Sentry error handler (must be before generic error handler) ──
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Generic error handler ─────────────────────────────────────
app.use(require('./lib/errorHandler').errorHandler);

// ── Serve Frontend ────────────────────────────────────────────
const FRONTEND = path.join(__dirname, '..', 'public');
// Landingpage auf "/", die App (mit Login) bleibt unter /index.html und /login erreichbar.
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND, Object.keys(req.query).length ? 'index.html' : 'landing.html')));
app.get('/login', (_, res) => res.redirect(302, '/index.html'));
app.use(express.static(FRONTEND, { index: false }));
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
  // Neue Tabellen/Spalten (additiv); ein Fehler hier darf den Start nicht verhindern.
  require('./lib/schemaRedesign').ensureSchema().catch(e => console.error('[schema-redesign] failed:', e.message));
  server.listen(PORT, () => console.log(`RhetorIQ server running on :${PORT}`));

  // ── Scheduled reports ──────────────────────────────────────────
  // Weekly: every Sunday at 08:00 Zurich
  cron.schedule('0 8 * * 0', () => runWeeklyReport(), { timezone: 'Europe/Zurich' });

  // Monthly: 1st of each month at 08:07
  cron.schedule('7 8 1 * *', () => runMonthlyReport(), { timezone: 'Europe/Zurich' });

  // Kommunikationsprofil: am 1. und 15. jedes Monats um 09:30
  cron.schedule('30 9 1,15 * *', () => require('./jobs/comm-profile').runCommProfileJob().catch(e => console.error('[comm-profile] job failed:', e.message)), { timezone: 'Europe/Zurich' });
  console.log('[cron] Weekly report: every Sunday 08:00 Zurich');
  console.log('[cron] Monthly report: 1st of month 08:07 Zurich');

  // ── Email reliability: outbox sweeper + missed-report catch-up ─────
  // node-cron only fires while the process is running at that exact instant
  // — a redeploy or restart right at 08:00 Sunday silently skips that tick
  // with no built-in retry. ensureRecentWeeklyReport() runs once at boot and
  // sends immediately if no report went out in the last 8 days, so a missed
  // cron tick self-heals on the next restart instead of waiting a full week.
  // sweepOutbox() retries every not-yet-sent email (feedback, "an Beraterin
  // senden", reports) every 3 minutes, independent of whatever request or
  // process originally tried to send it — this is what makes delivery
  // actually reliable rather than best-effort.
  ensureRecentWeeklyReport().catch(e => console.error('[weekly-report] boot catch-up failed:', e.message));
  sweepOutbox().catch(e => console.error('[email-outbox] boot sweep failed:', e.message));
  cron.schedule('*/3 * * * *', () => sweepOutbox().catch(e => console.error('[email-outbox] sweep failed:', e.message)));
  console.log('[cron] Email outbox sweep: every 3 minutes');

  // Monatserinnerung an den Export der Stimmenmappen: am 1. um 09:00, nur eine Mail ohne Anhang
  cron.schedule('0 9 1 * *', () => require('./jobs/stimmenmappe-erinnerung').runErinnerung().catch(e => console.error('[stimmenmappe] Erinnerung failed:', e.message)), { timezone: 'Europe/Zurich' });

  // KI-Wächter: alle 5 Minuten eine winzige Anfrage (haiku, 5 Token), sichtbar im Nutzungsprotokoll unter «waechter».
  // Abschaltbar mit KI_WAECHTER=aus.
  if ((process.env.KI_WAECHTER || '').toLowerCase() !== 'aus') {
    cron.schedule('*/5 * * * *', () => require('./jobs/ki-waechter').runWaechter().catch(e => console.error('[ki-waechter] failed:', e.message)));
    console.log('[cron] KI-Wächter: every 5 minutes');
  }
})();

// Unbehandelte Fehler protokollieren und an Sentry melden. Eine abgelehnte Zusage beendet den Prozess nicht;
// nach einem uncaughtException ist der Zustand unsicher, deshalb endet der Prozess geordnet und Render startet ihn neu.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  try { Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason))); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  try { Sentry.captureException(err); } catch {}
  try { Sentry.flush(2000).finally(() => process.exit(1)); } catch { process.exit(1); }
  setTimeout(() => process.exit(1), 3000).unref();
});

function gracefulShutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
