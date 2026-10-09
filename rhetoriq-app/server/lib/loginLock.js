// Sperre pro Konto bei zu vielen Fehlversuchen (Befund F-13): 10 Fehlversuche in 15 Minuten, dann 15 Minuten Pause.
// Ergänzt die Drosselung je Adresse (index.js), die verteilte Versuche nicht erfasst. Liegt im Arbeitsspeicher
// (bei einer Instanz ausreichend; ein Neustart hebt die Sperre auf). Gezählt wird auch bei unbekannten Adressen,
// damit die Antwort nichts über die Existenz eines Kontos verrät.
const WINDOW_MS = parseInt(process.env.LOGIN_LOCK_WINDOW_MS, 10) || 15 * 60 * 1000;
const PAUSE_MS = parseInt(process.env.LOGIN_LOCK_PAUSE_MS, 10) || 15 * 60 * 1000;
const MAX_FAILS = parseInt(process.env.LOGIN_LOCK_MAX, 10) || 10;

const state = new Map(); // key -> { fails: [Zeitpunkte], lockedUntil }

const keyOf = (kind, id) => kind + ':' + String(id || '').trim().toLowerCase().slice(0, 200);

function remainingMs(key) {
  const s = state.get(key);
  if (!s || !s.lockedUntil) return 0;
  const left = s.lockedUntil - Date.now();
  if (left <= 0) { state.delete(key); return 0; }
  return left;
}

function recordFailure(key) {
  const now = Date.now();
  const s = state.get(key) || { fails: [], lockedUntil: 0 };
  s.fails = s.fails.filter(t => now - t < WINDOW_MS);
  s.fails.push(now);
  if (s.fails.length >= MAX_FAILS) { s.lockedUntil = now + PAUSE_MS; s.fails = []; }
  state.set(key, s);
  if (state.size > 5000) { for (const [k, v] of state) if (!v.lockedUntil && !v.fails.length) state.delete(k); }
}

function recordSuccess(key) { state.delete(key); }

// Middleware-Hilfe: gibt true zurück und antwortet mit 429, wenn gesperrt
function blocked(res, key) {
  const left = remainingMs(key);
  if (!left) return false;
  res.status(429).json({ error: `Zu viele Fehlversuche für dieses Konto. Bitte in ${Math.ceil(left / 60000)} Minuten erneut versuchen.` });
  return true;
}

function reset() { state.clear(); }

module.exports = { keyOf, remainingMs, recordFailure, recordSuccess, blocked, reset, MAX_FAILS };
