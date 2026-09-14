const API = 'https://rhetoriq.ch';
let token = null;
let replyToText = '';

function show(id, on) { document.getElementById(id).style.display = on ? '' : 'none'; }

Office.onReady(() => {
  token = localStorage.getItem('riq-addin-token') || null;
  if (token) {
    show('login-view', false);
    show('main-view', true);
  } else {
    show('login-view', true);
  }

  // If this is a reply/existing message, grab its body as context so the
  // generated email can respond directly to what's already there.
  if (Office.context.mailbox.item && Office.context.mailbox.item.body) {
    Office.context.mailbox.item.body.getAsync(Office.CoercionType.Text, (res) => {
      if (res.status === Office.AsyncResultStatus.Succeeded && res.value && res.value.trim()) {
        replyToText = res.value.trim();
        document.getElementById('reply-hint').style.display = '';
      }
    });
  }

  document.getElementById('login-btn').onclick = login;
  document.getElementById('gen-btn').onclick = generate;
  document.getElementById('insert-btn').onclick = insert;
});

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-pw').value;
  const err = document.getElementById('login-err');
  err.style.display = 'none';
  if (!email || !pw) { err.textContent = 'E-Mail und Passwort eingeben.'; err.style.display = ''; return; }
  try {
    const r = await fetch(API + '/auth/client-password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Login fehlgeschlagen');
    token = d.token;
    localStorage.setItem('riq-addin-token', token);
    show('login-view', false);
    show('main-view', true);
  } catch (e) {
    err.textContent = e.message;
    err.style.display = '';
  }
}

async function generate() {
  const briefing = document.getElementById('briefing').value.trim();
  const err = document.getElementById('err');
  const resultBox = document.getElementById('result');
  const genBtn = document.getElementById('gen-btn');
  const insertBtn = document.getElementById('insert-btn');
  err.style.display = 'none';
  if (!briefing) { err.textContent = 'Bitte kurz beschreiben, worum es geht.'; err.style.display = ''; return; }
  genBtn.disabled = true;
  genBtn.textContent = 'Wird generiert…';
  resultBox.style.display = 'none';
  insertBtn.style.display = 'none';
  try {
    const r = await fetch(API + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        module: 'text-gen',
        instructionsKey: 'text-gen-email',
        data: {
          text: briefing,
          format: 'External — Client / Partner',
          audience: document.getElementById('audience').value,
          tone: document.getElementById('tone').value,
          language: 'Deutsch',
          replyTo: replyToText || undefined
        }
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Generierung fehlgeschlagen');
    const text = d.result || d.text || '';
    resultBox.textContent = text;
    resultBox.style.display = '';
    insertBtn.style.display = '';
    insertBtn.dataset.text = text;
  } catch (e) {
    err.textContent = e.message;
    err.style.display = '';
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = 'Generieren';
  }
}

function insert() {
  const text = document.getElementById('insert-btn').dataset.text || '';
  if (!text) return;
  Office.context.mailbox.item.body.setAsync(text, { coercionType: Office.CoercionType.Text }, (res) => {
    if (res.status !== Office.AsyncResultStatus.Succeeded) {
      document.getElementById('err').textContent = 'Einfügen fehlgeschlagen: ' + (res.error && res.error.message);
      document.getElementById('err').style.display = '';
    }
  });
}
