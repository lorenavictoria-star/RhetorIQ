// Klaviyo-Schnittstelle (private API-Schlüssel). Alle Aufrufe laufen über request(); der Schlüssel steht nur im Header
// und taucht nie in Fehlermeldungen oder Logs auf (lib/scrub.js). Fehlermeldungen sind deutsch.
// NIE wird ein Versand ausgelöst: Es gibt hier absichtlich keinen Aufruf an campaign-send-jobs. Kampagnen entstehen nur als Entwurf.
// Benötigte Rechte (Scopes) des privaten Schlüssels in Klaviyo: Templates (Vollzugriff), Campaigns (Vollzugriff), Lists (Lesen).
// Die Revision entspricht dem bestehenden Code in routes/klaviyo.js.
const { scrubText } = require('./scrub');

const BASE = 'https://a.klaviyo.com';
const REVISION = '2024-02-15';
const TIMEOUT_MS = 20000;
const KEY_FORM = /^pk_[A-Za-z0-9_-]{16,}$/;

class KlaviyoFehler extends Error {
  constructor(code, message, status) { super(message); this.name = 'KlaviyoFehler'; this.code = code; this.status = status || null; }
}

function texte(du) {
  return {
    ungueltig: du
      ? 'Der Klaviyo-Schlüssel ist ungültig oder wurde widerrufen. Erstelle in Klaviyo einen neuen privaten Schlüssel und trage ihn neu ein.'
      : 'Der Klaviyo-Schlüssel ist ungültig oder wurde widerrufen. Bitte erstellen Sie in Klaviyo einen neuen privaten Schlüssel und tragen Sie ihn neu ein.',
    scope: du
      ? 'Dem Klaviyo-Schlüssel fehlen Rechte. Er braucht Templates (Vollzugriff), Campaigns (Vollzugriff) und Lists (Lesen).'
      : 'Dem Klaviyo-Schlüssel fehlen Rechte. Er braucht Templates (Vollzugriff), Campaigns (Vollzugriff) und Lists (Lesen). Bitte erstellen Sie in Klaviyo einen neuen Schlüssel mit diesen Rechten.',
    limit: du ? 'Klaviyo lässt gerade keine weiteren Anfragen zu (Limit erreicht). Versuche es in einer Minute erneut.' : 'Klaviyo lässt gerade keine weiteren Anfragen zu (Limit erreicht). Bitte versuchen Sie es in einer Minute erneut.',
    server: du ? 'Klaviyo antwortet gerade nicht. Versuche es später erneut.' : 'Klaviyo antwortet gerade nicht. Bitte versuchen Sie es später erneut.',
    netz: du ? 'Klaviyo ist nicht erreichbar. Versuche es später erneut.' : 'Klaviyo ist nicht erreichbar. Bitte versuchen Sie es später erneut.',
    format: du ? 'Das ist kein privater Klaviyo-Schlüssel. Er beginnt mit pk_ (der öffentliche Schlüssel mit sechs Zeichen genügt nicht).' : 'Das ist kein privater Klaviyo-Schlüssel. Er beginnt mit pk_ (der öffentliche Schlüssel mit sechs Zeichen genügt nicht).',
    anfrage: du ? 'Klaviyo hat die Anfrage abgelehnt' : 'Klaviyo hat die Anfrage abgelehnt'
  };
}

function formatOk(key) { return KEY_FORM.test(String(key || '').trim()); }

async function request(apiKey, method, path, body, opts = {}) {
  const du = !!opts.du;
  const T = texte(du);
  let r;
  try {
    r = await globalThis.fetch(path.startsWith('http') ? path : BASE + path, {
      method,
      headers: {
        'Authorization': `Klaviyo-API-Key ${apiKey}`,
        'revision': REVISION,
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined
    });
  } catch {
    throw new KlaviyoFehler('netz', T.netz);
  }
  let d = null;
  try { d = await r.json(); } catch { d = null; }
  if (r.ok) return d || {};
  const e0 = d && d.errors && d.errors[0];
  if (r.status === 401) throw new KlaviyoFehler('ungueltig', T.ungueltig, 401);
  if (r.status === 403) throw new KlaviyoFehler('scope', T.scope, 403);
  if (r.status === 429) throw new KlaviyoFehler('limit', T.limit, 429);
  if (r.status >= 500) throw new KlaviyoFehler('server', T.server, r.status);
  const detail = scrubText((e0 && (e0.detail || e0.title)) || '', apiKey).slice(0, 300);
  throw new KlaviyoFehler('anfrage', `${T.anfrage}${detail ? ': ' + detail : '.'}`, r.status);
}

// Prüft Gültigkeit und Rechte. Gibt { gueltig, rechte: { vorlagen, listen, kampagnen } }. Wirft bei Netz, Limit oder Serverfehler.
async function pruefe(apiKey, opts = {}) {
  const probe = async (path) => {
    try { await request(apiKey, 'GET', path, null, opts); return true; }
    catch (e) {
      if (e.code === 'scope') return false;
      throw e;
    }
  };
  try {
    const vorlagen = await probe('/api/templates/?page[size]=1');
    const listen = await probe('/api/lists/?page[size]=1');
    const kampagnen = await probe("/api/campaigns/?filter=equals(messages.channel,'email')&page[size]=1");
    return { gueltig: true, rechte: { vorlagen, listen, kampagnen } };
  } catch (e) {
    if (e.code === 'ungueltig') return { gueltig: false, rechte: { vorlagen: false, listen: false, kampagnen: false } };
    throw e;
  }
}

async function listen(apiKey, opts = {}) {
  let url = '/api/lists/?page[size]=50';
  const out = [];
  for (let i = 0; i < 3 && url; i++) {
    const d = await request(apiKey, 'GET', url, null, opts);
    for (const x of d.data || []) out.push({ id: x.id, name: String((x.attributes && x.attributes.name) || 'Ohne Namen').slice(0, 120) });
    url = d.links && d.links.next ? d.links.next : null;
  }
  return out;
}

// Vorhandene Vorlagen (für die Beraterin, als Stilvorlage)
async function vorlagen(apiKey, opts = {}) {
  let url = '/api/templates/?page[size]=10';
  let out = [];
  for (let page = 0; page < 5 && url; page++) {
    const d = await request(apiKey, 'GET', url, null, opts);
    out = out.concat((d.data || []).map(t => ({ id: t.id, name: (t.attributes && t.attributes.name) || 'Ohne Namen', html: (t.attributes && t.attributes.html) || '', created: t.attributes && t.attributes.created })));
    url = d.links && d.links.next ? d.links.next : null;
  }
  return out;
}

async function legeVorlageAn(apiKey, name, html, opts = {}) {
  const d = await request(apiKey, 'POST', '/api/templates/', {
    data: { type: 'template', attributes: { name: String(name).slice(0, 150), html, editor_type: 'CODE' } }
  }, opts);
  return d.data && d.data.id;
}

// Kampagnenentwurf mit der Vorlage. Es wird nichts versendet und kein Versand ausgelöst.
async function legeKampagnenentwurfAn(apiKey, { name, listId, betreff, vorschau, absenderEmail, absenderName, vorlageId }, opts = {}) {
  const d = await request(apiKey, 'POST', '/api/campaigns/', {
    data: {
      type: 'campaign',
      attributes: {
        name: String(name).slice(0, 150),
        audiences: { included: [listId] },
        send_options: { use_smart_sending: true },
        send_strategy: { method: 'immediate' },
        'campaign-messages': {
          data: [{
            type: 'campaign-message',
            attributes: {
              channel: 'email',
              label: String(name).slice(0, 100),
              content: { subject: String(betreff || name).slice(0, 200), preview_text: String(vorschau || '').slice(0, 200), from_email: absenderEmail, from_label: String(absenderName || '').slice(0, 100) || undefined, reply_to_email: absenderEmail }
            }
          }]
        }
      }
    }
  }, opts);
  const kampagneId = d.data && d.data.id;
  const rel = d.data && d.data.relationships && d.data.relationships['campaign-messages'] && d.data.relationships['campaign-messages'].data;
  const msgId = (rel && rel[0] && rel[0].id) || ((d.included || []).find(x => x.type === 'campaign-message') || {}).id;
  if (!kampagneId || !msgId) throw new KlaviyoFehler('anfrage', 'Klaviyo hat den Kampagnenentwurf angelegt, aber die Nachricht nicht gemeldet. Die Vorlage ist vorhanden.');
  await request(apiKey, 'POST', '/api/campaign-message-assign-template/', {
    data: { type: 'campaign-message', id: msgId, relationships: { template: { data: { type: 'template', id: vorlageId } } } }
  }, opts);
  return { kampagneId, nachrichtId: msgId };
}

module.exports = { request, pruefe, listen, vorlagen, legeVorlageAn, legeKampagnenentwurfAn, formatOk, KlaviyoFehler, texte, REVISION };
