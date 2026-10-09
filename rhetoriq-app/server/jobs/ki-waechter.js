// KI-Wächter, kostengünstig gebaut:
//  - alle 5 Minuten ein KOSTENLOSER Prüfaufruf: POST /v1/messages/count_tokens mit dem Schlüssel (wird nicht abgerechnet).
//    Er zeigt, ob die Schnittstelle erreichbar ist und der Schlüssel gilt.
//  - nur alle 30 Minuten ein echter, winziger Erzeugungsaufruf (haiku, 1 Ausgabe-Token, Modul «waechter» im Nutzungsprotokoll).
//    Er findet, was der Prüfaufruf NICHT sieht: überlastetes oder gesperrtes Modell, leeres Guthaben, Fehler der Erzeugung.
//  - Bei Fehlern (oder einer laufenden Störung) werden in jedem 5-Minuten-Lauf beide Prüfungen gemacht.
//  - Die öffentliche Statusseite (status.anthropic.com) wird nur bei einem Fehler gelesen und steht in der Alarmmail.
// Bei drei Fehlern in Folge: Statusflag ki_stoerung und eine Mail an Lorena (einmal pro Störung), bei Wiederkehr eine Entwarnung.
// Mit dem Tagesbudget aus lib/budget.js (Funktion «waechter») kann der Erzeugungsaufruf nie ausufern.
const { getStatus, setStatus } = require('../lib/systemStatus');

const SCHWELLE = 3;
const GEN_INTERVALL_MS = 30 * 60 * 1000;
const NOTIFY = () => process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (t.unref) t.unref();
  return c.signal;
}

// Kostenloser Prüfaufruf: Token zählen, ohne etwas zu erzeugen. Erkennt: Schnittstelle nicht erreichbar, Schlüssel ungültig,
// Konto gesperrt. Erkennt NICHT: Modell überlastet, Erzeugung gestört, leeres Guthaben (zuverlässig nicht belegt).
async function cheapCheck() {
  const ai = require('../lib/aiProvider');
  const order = typeof ai.keyOrder === 'function' ? await ai.keyOrder() : [{ key: process.env.ANTHROPIC_API_KEY }];
  const key = order[0] && order[0].key;
  if (!key) throw new Error('Kein API-Schlüssel gesetzt');
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    signal: timeoutSignal(15000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ai.resolveModelId('haiku'), messages: [{ role: 'user', content: 'ok' }] })
  });
  let data = null;
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok) { const e = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
  if (!data || typeof data.input_tokens !== 'number') throw new Error('Unerwartete Antwort der Zählschnittstelle');
  return data;
}

// Echter, winziger Erzeugungsaufruf (1 Ausgabe-Token)
async function pingKi() {
  const ai = require('../lib/aiProvider');
  const r = await ai.generateText({
    model: ai.resolveModelId('haiku'),
    system: 'Antworte mit einem einzigen Wort.',
    messages: [{ role: 'user', content: 'Sag ok.' }],
    maxTokens: 1,
    meter: { module: 'waechter', advisorId: null, clientId: null }
  });
  if (!r || typeof r.text !== 'string') throw new Error('Leere Antwort');
  return r;
}

// Öffentliche Statusseite, nur zur Diagnose bei einem Fehler. Wirft nie.
async function statusSeite() {
  try {
    const res = await fetch('https://status.anthropic.com/api/v2/status.json', { signal: timeoutSignal(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.status ? `${j.status.indicator || '?'}: ${j.status.description || ''}`.slice(0, 160) : null;
  } catch { return null; }
}

async function mail(subject, text) {
  const { queueEmail } = require('../lib/emailOutbox');
  await queueEmail({ kind: 'ki-waechter', to: NOTIFY(), subject, text, senderName: 'RhetorIQ Wächter' });
}

// cheap, ping, status: austauschbar für Tests. now: Uhrzeit für Tests.
async function runWaechter({ cheap = cheapCheck, ping = pingKi, status = statusSeite, now = Date.now() } = {}) {
  const st = (await getStatus('ki_waechter', null)) || { fails: 0, stoerung: false, mailSent: false };
  const jetzt = new Date(now).toISOString();
  const lastGen = st.lastGen ? Date.parse(st.lastGen) : 0;
  // Echter Aufruf: alle 30 Minuten, bei Fehlern oder laufender Störung in jedem Lauf
  let genFaellig = (st.fails || 0) > 0 || !!st.stoerung || !lastGen || now - lastGen >= GEN_INTERVALL_MS;
  let genUebersprungen = false;
  if (genFaellig) {
    const b = await require('../lib/budget').allow('waechter').catch(() => ({ ok: true }));
    if (!b.ok) { genFaellig = false; genUebersprungen = true; }
  }
  let ok = true, fehler = null, gen = false;
  try { await cheap(); } catch (e) { ok = false; fehler = ('Prüfaufruf: ' + String(e.message || e)).slice(0, 300); }
  if (ok && genFaellig) {
    gen = true;
    try { await ping(); } catch (e) { ok = false; fehler = ('Erzeugung: ' + String(e.message || e)).slice(0, 300); }
  }
  const lastGenNeu = gen ? jetzt : (st.lastGen || null);
  // Tagesbudget erreicht und Störung offen: Zustand nicht verändern (kein Entwarnen ohne echten Aufruf)
  if (ok && genUebersprungen && (st.stoerung || (st.fails || 0) > 0)) return { ok: true, gen: false, uebersprungen: true };

  if (ok) {
    const warStoerung = !!st.stoerung;
    const neu = { fails: 0, stoerung: false, mailSent: false, lastOk: jetzt, lastFail: st.lastFail || null, lastError: null, since: null, lastGen: lastGenNeu };
    await setStatus('ki_waechter', neu);
    await setStatus('ki_stoerung', false);
    if (warStoerung && st.mailSent) {
      await mail('RhetorIQ: Entwarnung, die KI läuft wieder',
        `Hallo Lorena\n\nDie KI-Erzeugung antwortet wieder (Störung seit ${st.since || 'unbekannt'}, Entwarnung um ${jetzt}).\n\nNächster Schritt laut Notfallkarte: auf der Seite Nutzung den Selbsttest nach Störung ausführen und den Hinweis in der Plattform prüfen.\n\nRhetorIQ`)
        .catch(e => console.error('[ki-waechter] Entwarnungsmail fehlgeschlagen:', e.message));
    }
    return { ok: true, entwarnung: warStoerung, gen };
  }

  const fails = (st.fails || 0) + 1;
  const neu = { fails, stoerung: fails >= SCHWELLE, mailSent: !!st.mailSent, lastOk: st.lastOk || null, lastFail: jetzt, lastError: fehler, since: st.since || null, lastGen: lastGenNeu };
  let alarm = false;
  if (fails >= SCHWELLE) {
    if (!st.stoerung) neu.since = jetzt;
    if (!st.mailSent) {
      try {
        const sts = await status().catch(() => null);
        await mail('RhetorIQ: Die KI-Erzeugung ist gestört',
          `Hallo Lorena\n\nDie KI hat dreimal in Folge nicht geantwortet (letzte Meldung: ${fehler}).${sts ? `\nStatusseite von Anthropic: ${sts}` : ''}\n\nIn der Plattform steht jetzt für alle ein Hinweis. Prüfe als Nächstes die Statusseite status.anthropic.com und das Guthaben im Anthropic-Konto. Mit dem Schalter «Reservekonto erzwingen» auf der Seite Nutzung kannst du ohne Deploy auf das zweite Konto wechseln, falls eines eingerichtet ist.\n\nDiese Mail kommt einmal pro Störung.\n\nRhetorIQ`);
        neu.mailSent = true; alarm = true;
      } catch (e) { console.error('[ki-waechter] Alarmmail fehlgeschlagen:', e.message); }
    }
  }
  await setStatus('ki_waechter', neu);
  if (neu.stoerung) await setStatus('ki_stoerung', true);
  return { ok: false, fails, stoerung: neu.stoerung, alarm, gen };
}

module.exports = { runWaechter, pingKi, cheapCheck, statusSeite, SCHWELLE, GEN_INTERVALL_MS };
