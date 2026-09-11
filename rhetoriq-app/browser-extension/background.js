const API = 'https://rhetoriq.ch';

async function getToken() {
  const { riqToken } = await chrome.storage.local.get('riqToken');
  return riqToken || null;
}

async function login(email, password) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Login fehlgeschlagen');
  await chrome.storage.local.set({ riqToken: d.token, riqUser: d.user || null });
  return d;
}

async function generate({ text, audience, tone, replyTo }) {
  const token = await getToken();
  if (!token) throw new Error('NOT_LOGGED_IN');
  const r = await fetch(API + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      module: 'text-gen',
      data: {
        text,
        format: 'External — Client / Partner',
        audience: audience || 'B2B — General Business',
        tone: tone || 'Aus Voice Profile',
        language: 'Deutsch',
        replyTo: replyTo || undefined
      }
    })
  });
  const d = await r.json();
  if (!r.ok) {
    if (r.status === 401) { await chrome.storage.local.remove('riqToken'); throw new Error('NOT_LOGGED_IN'); }
    throw new Error(d.error || 'Generierung fehlgeschlagen');
  }
  return d.result || d.text || '';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'getToken') {
        sendResponse({ ok: true, token: await getToken() });
      } else if (msg.type === 'login') {
        const d = await login(msg.email, msg.password);
        sendResponse({ ok: true, data: d });
      } else if (msg.type === 'logout') {
        await chrome.storage.local.remove(['riqToken', 'riqUser']);
        sendResponse({ ok: true });
      } else if (msg.type === 'generate') {
        const text = await generate(msg.payload || {});
        sendResponse({ ok: true, text });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
