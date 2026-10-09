// ── AI PROVIDER ADAPTER ─────────────────────────────────────────────────────
// Single seam between "what RhetorIQ wants to generate" (prompts, modules,
// business logic in routes/analyze.js) and "which AI vendor actually runs
// it". Nothing outside this file should ever construct a fetch() call to an
// AI vendor's API, know its header names, its request/response shape, or its
// streaming event format.
//
// To add a new provider (e.g. Kimi K2): write one more entry in PROVIDERS
// below that implements generate() and stream() with the same signatures and
// return shapes as the 'anthropic' entry. Nothing else in the codebase needs
// to change — callers only ever deal with { text, inputTokens, outputTokens }
// and the { type: 'text'|'usage', ... } stream event shape.
//
// Model selection is deliberately abstract everywhere else in the app:
// callers pass a PRESET ('sonnet' | 'haiku' — "capable" vs "fast/cheap"),
// never a literal vendor model ID. resolveModelId() below is the only place
// that maps a preset to an actual model string, per active provider.
//
// Ausfallsicherheit (Szenario 1 und 2 im Ausfallbericht):
//  - Wiederholung bei Überlastung (HTTP 429, 500, 502, 503, 529): zwei Wiederholungen mit kurzer Wartezeit.
//    Im Stream nur vor dem ersten Token (der Verbindungsaufbau), danach nie.
//  - Modellnamen als Einstellungen: MODEL_SONNET, MODEL_HAIKU (Standard: die heutigen).
//  - Reservekonto: zweiter Schlüssel ANTHROPIC_API_KEY_2. Bei Kontofehlern (401, 402, 403 oder Meldung zu
//    Guthaben/Zahlung) und nach erschöpften Wiederholungen wird automatisch der zweite Schlüssel versucht.
//    Das Ergebnis trägt reserve:true, das Nutzungsprotokoll das Modell «reserve:...».
//  - Schalter ohne Deploy: system_status-Schlüssel ai_reserve_erzwingen ({an:true}) erzwingt das Reservekonto.

const ACTIVE_PROVIDER = process.env.AI_PROVIDER || 'anthropic';

const MODEL_PRESETS = {
  // Confirmed via a live A/B test (2026-09-01): claude-sonnet-5 was taking
  // 90-180s+ just to produce a first token on a large existing-draft
  // revision — connection opened instantly, nothing but Anthropic's own
  // pings in between. The identical request on claude-sonnet-4-6 completed
  // normally. Most likely new-model launch capacity constraints on
  // sonnet-5, not a problem with the app or the request. Staying on
  // sonnet-4-6 until that's resolved — revisit and re-test before
  // upgrading again. (Umstellung ohne Deploy: MODEL_SONNET / MODEL_HAIKU setzen.)
  anthropic: {
    sonnet: () => process.env.MODEL_SONNET || 'claude-sonnet-4-6',
    haiku: () => process.env.MODEL_HAIKU || 'claude-haiku-4-5-20251001'
  },
  // kimi: { sonnet: () => 'kimi-k2', haiku: () => 'kimi-k2-turbo' },  // example — add when needed
};

function resolveModelId(preset) {
  const presets = MODEL_PRESETS[ACTIVE_PROVIDER];
  if (!presets) throw new Error(`Unknown AI_PROVIDER: ${ACTIVE_PROVIDER}`);
  return (presets[preset] || presets.sonnet)();
}

// A stalled upstream call with no timeout hangs the whole request forever —
// the user just sees the "thinking" indicator frozen with no way out. Two
// full passes (draft + critique) can legitimately take a while for
// long-form content, so this is generous, but it must still be finite.
const GENERATE_TIMEOUT_MS = 120_000;

// ── Wiederholung und Reservekonto ───────────────────────────────────────────
const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const ACCOUNT_STATUS = new Set([401, 402, 403]);
const ACCOUNT_MESSAGE = /credit|balance|billing|payment|insufficient|suspended|disabled|zahlung|guthaben/i;
// Wartezeiten vor Wiederholung 1 und 2 (Länge = Anzahl Wiederholungen). Tests setzen sie auf 0.
const cfg = { waits: [1500, 4000] };

function apiError(status, message) {
  const e = new Error(message || 'API error');
  e.status = status;
  return e;
}
function isRetriable(e) { return RETRY_STATUS.has(e.status) || e.network === true; }
function isAccountError(e) {
  return ACCOUNT_STATUS.has(e.status) || (e.status !== undefined && ACCOUNT_MESSAGE.test(String(e.message || '')));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _forceCache = { at: 0, value: false };
async function reserveForced() {
  if (Date.now() - _forceCache.at < 10_000) return _forceCache.value;
  let v = false;
  try {
    const st = await require('./systemStatus').getStatus('ai_reserve_erzwingen', null);
    v = !!(st && st.an === true);
  } catch { v = false; }
  _forceCache = { at: Date.now(), value: v };
  return v;
}
// Schalter wurde gerade geändert: Zwischenspeicher verwerfen
function resetReserveCache() { _forceCache = { at: 0, value: false }; }

async function keyOrder() {
  const primary = process.env.ANTHROPIC_API_KEY;
  const reserve = process.env.ANTHROPIC_API_KEY_2;
  if (reserve && await reserveForced()) return [{ key: reserve, reserve: true }];
  const keys = [{ key: primary, reserve: false }];
  if (reserve && reserve !== primary) keys.push({ key: reserve, reserve: true });
  return keys;
}

// Führt fn(key) mit Wiederholung und Schlüsselwechsel aus. Gibt { value, reserve } zurück.
async function withKeys(fn, signal) {
  const keys = await keyOrder();
  let lastErr;
  for (const k of keys) {
    for (let attempt = 0; attempt <= cfg.waits.length; attempt++) {
      try {
        const value = await fn(k.key);
        return { value, reserve: k.reserve };
      } catch (e) {
        lastErr = e;
        if (signal && signal.aborted) throw e;
        if (isAccountError(e)) break;                    // anderes Konto versuchen
        if (!isRetriable(e)) throw e;                    // z. B. 400 Anfrage fehlerhaft: Wiederholung hilft nicht
        if (attempt < cfg.waits.length) {
          console.warn(`[ai] ${e.status || 'Netzwerkfehler'}, Wiederholung ${attempt + 1} von ${cfg.waits.length}`);
          await sleep(cfg.waits[attempt]);
          continue;
        }
        break;                                           // Wiederholungen erschöpft: nächstes Konto
      }
    }
    if (k !== keys[keys.length - 1]) console.warn(`[ai] ${lastErr && lastErr.status ? 'HTTP ' + lastErr.status : 'Fehler'}: wechsle auf das Reservekonto`);
  }
  throw lastErr;
}

function buildBody({ system, messages, maxTokens, model, temperature }, stream) {
  const body = { model, max_tokens: maxTokens, messages };
  if (stream) body.stream = true;
  if (system !== undefined && system !== null && system !== '') {
    body.system = Array.isArray(system)
      ? system
      : [{ type: 'text', text: typeof system === 'function' ? system({}) : system }];
  }
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

function headers(key) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31'
  };
}

// ── Anthropic implementation ────────────────────────────────────────────────
async function anthropicGenerateOnce(opts, key) {
  const body = buildBody(opts, false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: headers(key),
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI request timed out — please try again.');
    e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok || (data && data.error)) throw apiError(res.status, data && data.error && data.error.message ? data.error.message : 'API error');
  if (!data) throw apiError(res.status, 'API error');
  return {
    text: data.content?.[0]?.text || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    cacheCreationTokens: data.usage?.cache_creation_input_tokens || 0,
    cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
    model: opts.model
  };
}

async function anthropicGenerate(opts) {
  const { value, reserve } = await withKeys((key) => anthropicGenerateOnce(opts, key));
  if (reserve) value.reserve = true;
  return value;
}

// Öffnet die Verbindung zum Stream (nur dieser Teil wird wiederholt, nie nach dem ersten Token).
async function openStream(opts, key, signal) {
  const body = buildBody(opts, true);
  // Guard the connection setup itself (not just the caller's own
  // disconnect/abort signal) — if Anthropic never responds to open the
  // stream, this would otherwise hang indefinitely with no way out.
  const internalController = new AbortController();
  const onExternalAbort = () => internalController.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => internalController.abort(), GENERATE_TIMEOUT_MS);
  let res;
  try {
    console.log(`[trace-ai] calling Anthropic, model=${opts.model}`);
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: internalController.signal,
      headers: headers(key),
      body: JSON.stringify(body)
    });
    console.log(`[trace-ai] Anthropic responded, status=${res.status}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw apiError(res.status, err.error?.message || 'API error');
    }
    return res;
  } catch (e) {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    if (e.status === undefined) {
      console.log(`[trace-ai] Anthropic fetch threw: ${e.name} ${e.message}`);
      if (e.name === 'AbortError') {
        if (!signal?.aborted) throw new Error('AI request timed out — please try again.');
        throw e;
      }
      e.network = true;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function* anthropicStream(opts) {
  const { signal } = opts;
  const { value: res, reserve } = await withKeys((key) => openStream(opts, key, signal), signal);
  if (reserve) yield { type: 'meta', reserve: true };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  // The connection-setup timeout above only guards opening the stream — once
  // it's open, a stalled upstream (Anthropic stops sending bytes mid-response,
  // no error, no close) leaves this loop awaiting reader.read() forever. The
  // SSE keepalive pings in the route above are a DUMB timer, unrelated to
  // whether real generation is happening — they'd keep the connection looking
  // alive to the browser indefinitely while nothing is actually produced.
  //
  // Two layers are needed here, confirmed by a live trace: Anthropic's own
  // stream sends periodic `event: ping` frames while it works, which arrive
  // as successful reader.read() calls even when zero real content has been
  // produced yet. A per-chunk timeout that resets on every read — pings
  // included — never fires in that case: a request was observed hanging for
  // 5+ minutes with nothing but pings until an unrelated server restart
  // killed it. So: readWithTimeout() below still catches a truly dead
  // connection (no bytes at all, not even pings), while firstTokenDeadline
  // separately caps the total time allowed before the FIRST real text_delta
  // — that one is set once and only cleared by actual content, never by pings.
  const READ_TIMEOUT_MS = 45_000;
  const FIRST_TOKEN_TIMEOUT_MS = 180_000;
  async function readWithTimeout() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI stream stalled — no data received for 45s.')), READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  const streamStart = Date.now();
  let gotFirstToken = false;
  while (true) {
    if (!gotFirstToken && Date.now() - streamStart > FIRST_TOKEN_TIMEOUT_MS) {
      throw new Error('AI request timed out — no content produced within 90s.');
    }
    const { done, value } = await readWithTimeout();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]' || !raw) continue;
      let evt;
      try { evt = JSON.parse(raw); } catch (e) { console.warn('SSE parse error:', e.message, raw.slice(0, 100)); continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        gotFirstToken = true;
        yield { type: 'text', text: evt.delta.text || '' };
      }
      if (evt.type === 'message_start' && evt.message?.usage) {
        yield { type: 'usage', inputTokens: evt.message.usage.input_tokens || 0, outputTokens: 0, cacheCreationTokens: evt.message.usage.cache_creation_input_tokens || 0, cacheReadTokens: evt.message.usage.cache_read_input_tokens || 0 };
      }
      if (evt.type === 'message_delta' && evt.usage) {
        yield { type: 'usage', inputTokens: undefined, outputTokens: evt.usage.output_tokens || 0 };
      }
    }
  }
}

// Weitere Anbieter: einen Eintrag mit generate() und stream() ergänzen (gleiche Rückgabeformen).
// Heute ist nur 'anthropic' umgesetzt, mit zwei Schlüsseln (Hauptkonto und Reservekonto).
const PROVIDERS = {
  anthropic: { generate: anthropicGenerate, stream: anthropicStream }
  // kimi: { generate: kimiGenerate, stream: kimiStream },  // add when needed
};

function activeProvider() {
  const p = PROVIDERS[ACTIVE_PROVIDER];
  if (!p) throw new Error(`Unknown AI_PROVIDER: ${ACTIVE_PROVIDER}`);
  return p;
}

// Merkt in der laufenden Anfrage (meter-Kontext), dass das Reservekonto genutzt wurde.
// Die Route kann das lesen und der Beraterin dezent anzeigen.
function markReserve() {
  try { const ctx = require('./meter').context(); if (ctx && typeof ctx === 'object') ctx.reserve = true; } catch { /* nur Anzeige */ }
}
const meterModel = (model, reserve) => (reserve ? 'reserve:' + model : model);

// generateText({ system, messages, maxTokens, model, temperature })
//   -> { text, inputTokens, outputTokens, reserve? }
async function generateText(opts) {
  const r = await activeProvider().generate(opts);
  if (r.reserve) markReserve();
  // Jeder Aufruf wird mit Tokens, Modell und Kosten protokolliert (lib/meter.js)
  require('./meter').record({ ...r, model: meterModel(r.model || opts.model, r.reserve), meter: opts.meter });
  return r;
}

// streamText({ system, messages, maxTokens, model, temperature, signal })
//   -> async generator yielding { type: 'text', text } | { type: 'usage', inputTokens?, outputTokens? }
function streamText(opts) {
  return (async function* () {
    const u = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    let reserve = false;
    try {
      for await (const evt of activeProvider().stream(opts)) {
        if (evt.type === 'meta') { if (evt.reserve) { reserve = true; markReserve(); } continue; }
        if (evt.type === 'usage') {
          if (evt.inputTokens !== undefined) u.inputTokens = evt.inputTokens;
          if (evt.outputTokens !== undefined && evt.outputTokens) u.outputTokens = evt.outputTokens;
          if (evt.cacheCreationTokens !== undefined) u.cacheCreationTokens = evt.cacheCreationTokens;
          if (evt.cacheReadTokens !== undefined) u.cacheReadTokens = evt.cacheReadTokens;
        }
        yield evt;
      }
    } finally {
      // Auch bei Abbruch oder Fehler: was die API bereits berechnet hat, wird erfasst
      require('./meter').record({ ...u, model: meterModel(opts.model, reserve), meter: opts.meter });
    }
  })();
}

module.exports = { generateText, streamText, resolveModelId, resetReserveCache, keyOrder, _cfg: cfg };
