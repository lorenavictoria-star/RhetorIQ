function show(id, on) { document.getElementById(id).style.display = on ? '' : 'none'; }

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'getToken' });
  const loggedIn = !!(res && res.ok && res.token);
  show('login-view', !loggedIn);
  show('logged-in', loggedIn);
}

document.getElementById('login-btn').onclick = async () => {
  const email = document.getElementById('email').value.trim();
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('err');
  err.style.display = 'none';
  if (!email || !pw) { err.textContent = 'E-Mail und Passwort eingeben.'; err.style.display = ''; return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'login', email, password: pw });
  btn.disabled = false;
  if (!res || !res.ok) {
    err.textContent = (res && res.error) || 'Login fehlgeschlagen.';
    err.style.display = '';
    return;
  }
  refresh();
};

document.getElementById('logout-btn').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'logout' });
  refresh();
};

refresh();
