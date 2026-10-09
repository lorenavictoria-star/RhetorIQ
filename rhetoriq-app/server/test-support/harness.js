// Testumgebung für die neuen Routen: pg-mem statt Postgres, Attrappen für KI und Mail.
// Keine echten Aufrufe (Anthropic, Brevo, Render-Datenbank).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.APP_URL = 'https://app.test';

const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { newDb, DataType } = require('pg-mem');

const mem = newDb();
// Textfunktionen von echtem Postgres, die pg-mem nicht mitbringt (nur für Tests)
mem.public.registerFunction({ name: 'left', args: [DataType.text, DataType.integer], returns: DataType.text, implementation: (t, n) => (t == null ? null : String(t).slice(0, n)) });
mem.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (t) => (t == null ? null : String(t).length) });
const { Pool } = mem.adapters.createPg();
const rawPool = new Pool();

// pg-mem verschluckt sich an manchen Binärinhalten (BYTEA). Für die Tests werden Buffer
// deshalb als Hex-Text abgelegt und beim Lesen wieder zurückverwandelt. Nur Testhilfe.
const HEXTAG = 'HEX:';
const pool = {
  async query(sql, params) {
    const p = params && params.map(v => (Buffer.isBuffer(v) ? Buffer.from(HEXTAG + v.toString('hex')) : v));
    const r = await rawPool.query(sql, p);
    for (const row of r.rows || []) {
      for (const k of Object.keys(row)) {
        const v = row[k];
        if (Buffer.isBuffer(v) && v.subarray(0, 4).toString() === HEXTAG) row[k] = Buffer.from(v.subarray(4).toString(), 'hex');
      }
    }
    return r;
  }
};

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}

stub('db.js', { pool, init: async () => {} });

const mails = [];
let mailFail = false;
stub('lib/emailOutbox.js', {
  queueEmail: async (m) => { if (mailFail) throw new Error('Mail kaputt'); mails.push(m); return mails.length; },
  sweepOutbox: async () => {},
  attemptSend: async () => {}
});

const brevoMails = [];
stub('lib/brevo.js', { brevoSend: async (m) => { brevoMails.push(m); return {}; } });

const ai = { calls: [], reply: '{}', fail: false };
stub('lib/aiProvider.js', {
  generateText: async (opts) => {
    ai.calls.push(opts);
    if (ai.fail) throw new Error('KI kaputt');
    return { text: typeof ai.reply === 'function' ? await ai.reply(opts) : ai.reply, inputTokens: 1, outputTokens: 1 };
  },
  streamText: async function* () {},
  resolveModelId: (p) => 'test-' + p
});

async function setupBase() {
  await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT, password_hash TEXT, name TEXT, role TEXT DEFAULT 'advisor', token_version INTEGER NOT NULL DEFAULT 1)`);
  await pool.query(`CREATE TABLE clients (
    id SERIAL PRIMARY KEY, advisor_id INTEGER, name TEXT NOT NULL, industry TEXT, contact TEXT, slug TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), email TEXT, client_type TEXT, salutation TEXT, last_name TEXT,
    password_hash TEXT, must_change_password BOOLEAN DEFAULT FALSE, token_version INTEGER NOT NULL DEFAULT 1,
    enabled_modules TEXT[], privacy_acknowledged_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE client_users (id SERIAL PRIMARY KEY, client_id INTEGER, token_version INTEGER NOT NULL DEFAULT 1)`);
  await pool.query(`CREATE TABLE analyses (id SERIAL PRIMARY KEY, client_id INTEGER, advisor_id INTEGER, module TEXT NOT NULL, module_label TEXT, input_data JSONB, result TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), user_rating SMALLINT, feedback_note TEXT, feedback_key TEXT)`);
  await pool.query(`CREATE TABLE review_requests (
    id SERIAL PRIMARY KEY, client_id INTEGER, module_label TEXT, original_text TEXT NOT NULL, edited_text TEXT, client_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    module_key TEXT, module_tile TEXT, review_context JSONB)`);
  await pool.query(`CREATE TABLE onboarding_tokens (id SERIAL PRIMARY KEY, client_id INTEGER, token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'), used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO users (email, name) VALUES ('lorena@test.ch', 'Lorena')`);
}

const advisorToken = (extra = {}) => jwt.sign({ id: 1, role: 'advisor', name: 'Lorena', tokenVersion: 1, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
const clientToken = (clientId, extra = {}) => jwt.sign({ clientId, clientName: 'K', role: 'client', advisorId: 1, tokenVersion: 1, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function addClient(name = 'Testfirma AG') {
  const slug = name.toLowerCase().replace(/[^a-z]/g, '') + Math.random().toString(36).slice(2, 7);
  const { rows } = await pool.query(
    `INSERT INTO clients (advisor_id, name, slug, token, email) VALUES (1,$1,$2,$3,'k@test.ch') RETURNING *`,
    [name, slug, 'tok' + slug]);
  return rows[0];
}

// mounts: Liste von [Pfad, Router oder Middleware]
async function startApp(mounts) {
  const app = express();
  // Gezielte Live-Meldungen mitschreiben, damit Tests prüfen können, wer sie bekäme
  const wsLog = [];
  app.locals.wss = { broadcast(d) { wsLog.push(['alle', d]); }, toAdvisors(d) { wsLog.push(['berater', d]); }, toAdvisor(id, d) { wsLog.push(['berater:' + id, d]); }, toClient(id, d) { wsLog.push(['klient:' + id, d]); }, log: wsLog };
  app.use(express.json({ limit: '15mb' }));
  for (const [p, r] of mounts) (p ? app.use(p, r) : app.use(r));
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, { token, body, raw } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload });
    if (raw) return r;
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  }
  return { app, server, base, call, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = {
  pool, mem, mails, brevoMails, ai, setupBase, advisorToken, clientToken, addClient, startApp,
  setMailFail: v => { mailFail = v; }
};
