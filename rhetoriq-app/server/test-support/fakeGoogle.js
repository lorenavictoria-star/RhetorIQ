// Attrappe der Google-Kalender-API und des OAuth-Servers für Tests. Kein echtes Netz.
// Wird mit googleApi._setHttp({ fetch: fake.fetch, sleep: fake.sleep }) eingehängt.
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

function antwort(status, body, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (n) => (h[String(n).toLowerCase()] ?? null) }, json: async () => (body === undefined ? null : body) };
}

function fakeGoogle() {
  const g = {
    refresh: '1//refresh-token-geheim-1234567890abcdef', access: 'ya29.access-token-geheim-1234567890',
    code: 'gute-code', scope: SCOPE, ohneRefresh: false, tokenAnfragen: [], widerrufen: [], kalender: null, ereignisse: new Map(), version: 0,
    log: [], sleeps: [], rate429: 0, serverFehler: 0, gone410: false, kanaele: [], gestoppt: [], listen: [], zaehler: 0, uhr: () => new Date().toISOString(), seitenGroesse: 0
  };
  const buche = (ev) => { ev.v = ++g.version; ev.etag = `"etag-${ev.v}"`; ev.updated = g.uhr(); return ev; };
  const fuer = (ev) => { const { v, ...rest } = ev; return JSON.parse(JSON.stringify(rest)); };

  g.sleep = async (ms) => { g.sleeps.push(ms); };
  g.fetch = async (url, opts = {}) => {
    const u = new URL(url), methode = (opts.method || 'GET').toUpperCase();
    const body = opts.body === undefined ? undefined : (u.hostname === 'oauth2.googleapis.com' ? Object.fromEntries(new URLSearchParams(opts.body)) : JSON.parse(opts.body));
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      g.tokenAnfragen.push(body);
      if (body.grant_type === 'authorization_code') {
        if (body.code !== g.code || !body.code_verifier || body.redirect_uri !== 'https://app.test/api/kalender/google/callback') return antwort(400, { error: 'invalid_grant' });
        return antwort(200, { access_token: g.access, expires_in: 3599, scope: g.scope, token_type: 'Bearer', ...(g.ohneRefresh ? {} : { refresh_token: g.refresh }) });
      }
      if (body.grant_type === 'refresh_token') {
        if (body.refresh_token !== g.refresh) return antwort(400, { error: 'invalid_grant' });
        return antwort(200, { access_token: g.access, expires_in: 3599, token_type: 'Bearer' });
      }
      return antwort(400, { error: 'unsupported_grant_type' });
    }
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') { g.widerrufen.push(body.token); return antwort(200, {}); }
    if (u.hostname !== 'www.googleapis.com') return antwort(404, {});
    const auth = (opts.headers || {}).Authorization;
    if (auth !== 'Bearer ' + g.access) return antwort(401, { error: { code: 401, message: 'Invalid Credentials' } });
    const pfad = u.pathname.replace('/calendar/v3', '');
    g.log.push({ methode, pfad, query: Object.fromEntries(u.searchParams), body });
    if (g.rate429 > 0) { g.rate429--; return antwort(429, { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } }, { 'Retry-After': '1' }); }
    if (g.serverFehler > 0) { g.serverFehler--; return antwort(503, { error: { code: 503 } }); }
    let m;
    if (methode === 'POST' && pfad === '/calendars') { g.kalender = { id: 'cal-1@group.calendar.google.com', ...body }; return antwort(200, g.kalender); }
    if (methode === 'GET' && (m = /^\/calendars\/([^/]+)$/.exec(pfad))) return g.kalender && decodeURIComponent(m[1]) === g.kalender.id ? antwort(200, g.kalender) : antwort(404, { error: { code: 404 } });
    if (methode === 'POST' && pfad === '/channels/stop') { g.gestoppt.push(body); return antwort(204); }
    if (methode === 'POST' && /^\/calendars\/[^/]+\/events\/watch$/.test(pfad)) {
      const k = { ...body, resourceId: 'res-' + (++g.zaehler), expiration: String(Date.now() + (g.kanalDauer || 7 * 24 * 3600 * 1000)) };
      g.kanaele.push(k);
      return antwort(200, { kind: 'api#channel', id: k.id, resourceId: k.resourceId, expiration: k.expiration });
    }
    if (methode === 'POST' && (m = /^\/calendars\/[^/]+\/events$/.exec(pfad))) {
      if (body.id && g.ereignisse.has(body.id)) return antwort(409, { error: { code: 409 } });
      const id = body.id || 'g' + (++g.zaehler);
      const ev = buche({ ...body, id, status: 'confirmed' });
      g.ereignisse.set(id, ev);
      return antwort(200, fuer(ev));
    }
    if ((m = /^\/calendars\/[^/]+\/events\/([^/]+)$/.exec(pfad))) {
      const id = decodeURIComponent(m[1]);
      const ev = g.ereignisse.get(id);
      if (methode === 'DELETE') { if (!ev || ev.status === 'cancelled') return antwort(410, { error: { code: 410 } }); ev.status = 'cancelled'; buche(ev); return antwort(204); }
      if (!ev || ev.status === 'cancelled') { if (methode === 'PUT') { const neu = buche({ ...body, id, status: 'confirmed' }); g.ereignisse.set(id, neu); return antwort(200, fuer(neu)); } return antwort(404, { error: { code: 404 } }); }
      if (methode === 'PATCH') {
        for (const [k, v] of Object.entries(body)) { if (k === 'extendedProperties') ev.extendedProperties = { private: { ...((ev.extendedProperties || {}).private || {}), ...v.private } }; else ev[k] = v; }
        buche(ev); return antwort(200, fuer(ev));
      }
      if (methode === 'PUT') { const neu = buche({ ...body, id, status: 'confirmed' }); g.ereignisse.set(id, neu); return antwort(200, fuer(neu)); }
    }
    if (methode === 'GET' && /^\/calendars\/[^/]+\/events$/.test(pfad)) {
      const q = Object.fromEntries(u.searchParams);
      g.listen.push(q);
      let ab = 0;
      if (q.syncToken) {
        if (g.gone410) { g.gone410 = false; return antwort(410, { error: { code: 410 } }); }
        ab = parseInt(String(q.syncToken).replace('st', ''), 10);
      }
      let items = [...g.ereignisse.values()].filter(e => e.v > ab && (q.syncToken || e.status !== 'cancelled')).sort((a, b) => a.v - b.v);
      let next = null;
      if (g.seitenGroesse) {
        const start = parseInt(q.pageToken || '0', 10);
        const rest = items.slice(start + g.seitenGroesse);
        items = items.slice(start, start + g.seitenGroesse);
        if (rest.length) next = String(start + g.seitenGroesse);
      }
      return antwort(200, { items: items.map(fuer), ...(next ? { nextPageToken: next } : { nextSyncToken: 'st' + g.version }) });
    }
    return antwort(404, { error: { code: 404 } });
  };

  // Handlungen am Handy
  g.handyNeu = (b) => { const id = 'h' + (++g.zaehler); const ev = buche({ id, status: 'confirmed', ...b }); g.ereignisse.set(id, ev); return id; };
  g.handyAendern = (id, b, updated) => { const ev = g.ereignisse.get(id); Object.assign(ev, b); buche(ev); if (updated) ev.updated = updated; return ev; };
  g.handyLoeschen = (id, updated) => { const ev = g.ereignisse.get(id); ev.status = 'cancelled'; buche(ev); if (updated) ev.updated = updated; };
  g.schreibaufrufe = () => g.log.filter(l => /events/.test(l.pfad) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(l.methode) && !/watch$/.test(l.pfad));
  g.aktive = () => [...g.ereignisse.values()].filter(e => e.status !== 'cancelled');
  return g;
}

module.exports = { fakeGoogle, SCOPE };
