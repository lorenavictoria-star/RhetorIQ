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

const ACTIVE_PROVIDER = process.env.AI_PROVIDER || 'anthropic';

const MODEL_PRESETS = {
  anthropic: { sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' },
  // kimi: { sonnet: 'kimi-k2', haiku: 'kimi-k2-turbo' },  // example — add when needed
};

function resolveModelId(preset) {
  const presets = MODEL_PRESETS[ACTIVE_PROVIDER];
  if (!presets) throw new Error(`Unknown AI_PROVIDER: ${ACTIVE_PROVIDER}`);
  return presets[preset] || presets.sonnet;
}

// A stalled upstream call with no timeout hangs the whole request forever —
// the user just sees the "thinking" indicator frozen with no way out. Two
// full passes (draft + critique) can legitimately take a while for
// long-form content, so this is generous, but it must still be finite.
const GENERATE_TIMEOUT_MS = 120_000;

// ── Anthropic implementation ────────────────────────────────────────────────
async function anthropicGenerate({ system, messages, maxTokens, model, temperature }) {
  const systemPayload = Array.isArray(system)
    ? system
    : [{ type: 'text', text: typeof system === 'function' ? system({}) : system }];
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPayload,
    messages
  };
  if (temperature !== undefined) body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI request timed out — please try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return {
    text: data.content?.[0]?.text || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0
  };
}

async function* anthropicStream({ system, messages, maxTokens, model, temperature, signal }) {
  const systemPayload = Array.isArray(system)
    ? system
    : [{ type: 'text', text: typeof system === 'function' ? system({}) : system }];
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: systemPayload,
    messages
  };
  if (temperature !== undefined) body.temperature = temperature;

  // Guard the connection setup itself (not just the caller's own
  // disconnect/abort signal) — if Anthropic never responds to open the
  // stream, this would otherwise hang indefinitely with no way out.
  const internalController = new AbortController();
  const onExternalAbort = () => internalController.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => internalController.abort(), GENERATE_TIMEOUT_MS);

  let res;
  console.log(`[trace-ai] calling Anthropic, model=${model}, apiKeySet=${!!process.env.ANTHROPIC_API_KEY}, apiKeyLen=${(process.env.ANTHROPIC_API_KEY||'').length}`);
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: internalController.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(body)
    });
    console.log(`[trace-ai] Anthropic responded, status=${res.status}`);
  } catch (e) {
    console.log(`[trace-ai] Anthropic fetch threw: ${e.name} ${e.message}`);
    if (e.name === 'AbortError' && !signal?.aborted) throw new Error('AI request timed out — please try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'API error');
  }

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
        yield { type: 'usage', inputTokens: evt.message.usage.input_tokens || 0, outputTokens: 0 };
      }
      if (evt.type === 'message_delta' && evt.usage) {
        yield { type: 'usage', inputTokens: undefined, outputTokens: evt.usage.output_tokens || 0 };
      }
    }
  }
}

const PROVIDERS = {
  anthropic: { generate: anthropicGenerate, stream: anthropicStream }
  // kimi: { generate: kimiGenerate, stream: kimiStream },  // add when needed
};

function activeProvider() {
  const p = PROVIDERS[ACTIVE_PROVIDER];
  if (!p) throw new Error(`Unknown AI_PROVIDER: ${ACTIVE_PROVIDER}`);
  return p;
}

// generateText({ system, messages, maxTokens, model, temperature })
//   -> { text, inputTokens, outputTokens }
async function generateText(opts) {
  return activeProvider().generate(opts);
}

// streamText({ system, messages, maxTokens, model, temperature, signal })
//   -> async generator yielding { type: 'text', text } | { type: 'usage', inputTokens?, outputTokens? }
function streamText(opts) {
  return activeProvider().stream(opts);
}

module.exports = { generateText, streamText, resolveModelId };
