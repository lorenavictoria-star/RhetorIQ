// Schlüssel aus Texten entfernen, bevor sie in Logs, Fehlermeldungen oder an Sentry gehen.
// Erkannt werden private Klaviyo-Schlüssel (pk_ + Zeichen) und Autorisierungsangaben im Klartext.
const PK = /\bpk_[A-Za-z0-9_-]{8,}/g;
const AUTH = /(Klaviyo-API-Key|Bearer)\s+[A-Za-z0-9._~+\/-]{8,}/gi;

function scrubText(t, extra) {
  let s = String(t == null ? '' : t).replace(PK, '[Schlüssel entfernt]').replace(AUTH, '$1 [entfernt]');
  if (extra && String(extra).length >= 8) s = s.split(String(extra)).join('[Schlüssel entfernt]');
  return s;
}

function scrubDeep(v, depth = 0) {
  if (depth > 6) return v;
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(x => scrubDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubDeep(v[k], depth + 1);
    return o;
  }
  return v;
}

// Für Sentry (beforeSend): Anfragekörper und Cookies entfallen ganz, in allem anderen werden Schlüsselmuster entfernt
function sentryBeforeSend(event) {
  try {
    if (event && event.request) { delete event.request.data; delete event.request.cookies; delete event.request.query_string; }
    return scrubDeep(event);
  } catch { return event; }
}

module.exports = { scrubText, scrubDeep, sentryBeforeSend };
