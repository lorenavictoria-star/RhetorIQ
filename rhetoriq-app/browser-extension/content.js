(function () {
  let fab = null;
  let panel = null;
  let activeField = null;
  let hideTimer = null;

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'search', 'url', ''].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function getFieldText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function setFieldText(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Guesses the right output format from the page + field, so the
  // extension never defaults to "email" everywhere — a LinkedIn comment
  // box should produce a short comment, a post box a full post, Gmail/
  // Outlook-web a proper email, and anything unrecognised falls back to a
  // neutral short-vs-long guess based on the field's own size.
  function detectFormat(el) {
    const host = location.hostname.replace(/^www\./, '');
    const hint = [
      el.getAttribute('aria-label'), el.getAttribute('placeholder'),
      el.getAttribute('name'), el.id, el.className
    ].filter(Boolean).join(' ').toLowerCase();

    if (host.includes('linkedin.com')) {
      if (hint.includes('comment') || hint.includes('kommentar')) return 'LinkedIn — Kommentar';
      return 'LinkedIn — Post';
    }
    if (host.includes('mail.google.com')) return 'External — Client / Partner (E-Mail)';
    if (host.includes('outlook.') || host.includes('bluewin.ch') || host.includes('gmx.')) return 'External — Client / Partner (E-Mail)';
    if (host.includes('slack.com')) return 'Slack-Nachricht — kurz und direkt';
    if (host.includes('teams.microsoft.com')) return 'Teams-Nachricht — kurz und direkt';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'X/Twitter-Post — kurz und pointiert';

    const rect = el.getBoundingClientRect();
    return rect.height < 60 ? 'Kurze Antwort / Kommentar' : 'Allgemeiner Text';
  }

  function removeFab() {
    if (fab) { fab.remove(); fab = null; }
  }
  function removePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  function placeNear(elToPlace, targetRect, preferBelow) {
    const top = preferBelow ? targetRect.bottom + 6 : Math.max(8, targetRect.top - 6);
    const left = Math.min(window.innerWidth - 40, targetRect.right - 34);
    elToPlace.style.top = top + 'px';
    elToPlace.style.left = left + 'px';
  }

  function showFab(field) {
    activeField = field;
    removeFab();
    const rect = field.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 16) return; // too small to bother
    fab = document.createElement('button');
    fab.className = 'riq-fab';
    fab.textContent = 'R';
    fab.title = 'RhetorIQ — Text generieren';
    fab.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(field); });
    document.body.appendChild(fab);
    placeNear(fab, rect, false);
  }

  async function openPanel(field) {
    removePanel();
    const rect = field.getBoundingClientRect();
    panel = document.createElement('div');
    panel.className = 'riq-panel';
    const existing = getFieldText(field).trim();
    const format = detectFormat(field);
    panel.innerHTML = `
      <button class="riq-close">&times;</button>
      <div class="riq-panel-title">RhetorIQ — Text generieren</div>
      <div class="riq-format-tag">${format}</div>
      <textarea placeholder="${existing ? 'Was soll geändert/beantwortet werden? (optional — vorhandener Inhalt wird berücksichtigt)' : 'Worum geht es? Kurz beschreiben…'}"></textarea>
      <div class="riq-err"></div>
      <div class="riq-result"></div>
      <button class="riq-generate">Generieren</button>
      <button class="riq-insert riq-secondary" style="display:none">In Feld einfügen</button>
    `;
    document.body.appendChild(panel);
    placeNear(panel, rect, true);
    // keep on-screen
    const pr = panel.getBoundingClientRect();
    if (pr.right > window.innerWidth) panel.style.left = (window.innerWidth - pr.width - 12) + 'px';
    if (pr.bottom > window.innerHeight) panel.style.top = (rect.top - pr.height - 10) + 'px';

    panel.querySelector('.riq-close').onclick = () => removePanel();
    const textarea = panel.querySelector('textarea');
    textarea.focus();
    const genBtn = panel.querySelector('.riq-generate');
    const insertBtn = panel.querySelector('.riq-insert');
    const resultBox = panel.querySelector('.riq-result');
    const errBox = panel.querySelector('.riq-err');

    genBtn.onclick = async () => {
      const briefing = textarea.value.trim();
      errBox.style.display = 'none';
      if (!briefing && !existing) {
        errBox.textContent = 'Bitte kurz beschreiben, worum es geht.';
        errBox.style.display = '';
        return;
      }
      genBtn.disabled = true;
      genBtn.textContent = 'Wird generiert…';
      resultBox.style.display = 'none';
      insertBtn.style.display = 'none';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'generate',
          payload: { text: briefing || 'Antworte passend auf den folgenden Inhalt.', replyTo: existing || undefined, format }
        });
        if (!res || !res.ok) {
          if (res && res.error === 'NOT_LOGGED_IN') {
            errBox.textContent = 'Bitte zuerst im RhetorIQ-Symbol oben rechts im Browser einloggen.';
          } else {
            errBox.textContent = (res && res.error) || 'Generierung fehlgeschlagen.';
          }
          errBox.style.display = '';
          return;
        }
        resultBox.textContent = res.text;
        resultBox.style.display = '';
        insertBtn.style.display = '';
        insertBtn.dataset.text = res.text;
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = 'Generieren';
      }
    };

    insertBtn.onclick = () => {
      const text = insertBtn.dataset.text || '';
      if (text && activeField) setFieldText(activeField, text);
      removePanel();
    };
  }

  document.addEventListener('focusin', (e) => {
    if (panel && panel.contains(e.target)) return;
    if (isEditable(e.target)) {
      showFab(e.target);
    }
  });

  document.addEventListener('focusout', (e) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const activeEl = document.activeElement;
      if (panel && panel.contains(activeEl)) return;
      if (fab && fab.matches(':hover')) return;
      removeFab();
      if (!(panel && panel.matches(':hover'))) removePanel();
    }, 150);
  });

  document.addEventListener('scroll', () => {
    if (activeField && fab) {
      const rect = activeField.getBoundingClientRect();
      placeNear(fab, rect, false);
    }
  }, true);
})();
