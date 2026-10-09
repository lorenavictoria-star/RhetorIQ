// KI-Wächter: alle 5 Minuten eine winzige Anfrage (haiku, höchstens 5 Ausgabe-Token).
// Jeder Aufruf steht im Nutzungsprotokoll unter dem Modul «waechter» (lib/meter.js), es gibt keine versteckten Kosten.
// Bei drei Fehlern in Folge: Statusflag ki_stoerung und eine Mail an Lorena (einmal pro Störung), bei Wiederkehr eine Entwarnung.
const { getStatus, setStatus } = require('../lib/systemStatus');

const SCHWELLE = 3;
const NOTIFY = () => process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

async function pingKi() {
  const ai = require('../lib/aiProvider');
  const r = await ai.generateText({
    model: ai.resolveModelId('haiku'),
    system: 'Antworte mit einem einzigen Wort.',
    messages: [{ role: 'user', content: 'Sag ok.' }],
    maxTokens: 5,
    meter: { module: 'waechter', advisorId: null, clientId: null }
  });
  if (!r || typeof r.text !== 'string') throw new Error('Leere Antwort');
  return r;
}

async function mail(subject, text) {
  const { queueEmail } = require('../lib/emailOutbox');
  await queueEmail({ kind: 'ki-waechter', to: NOTIFY(), subject, text, senderName: 'RhetorIQ Wächter' });
}

// ping: austauschbar für Tests
async function runWaechter({ ping = pingKi } = {}) {
  const st = (await getStatus('ki_waechter', null)) || { fails: 0, stoerung: false, mailSent: false };
  const jetzt = new Date().toISOString();
  let ok = true, fehler = null;
  try { await ping(); } catch (e) { ok = false; fehler = String(e.message || e).slice(0, 300); }

  if (ok) {
    const warStoerung = !!st.stoerung;
    const neu = { fails: 0, stoerung: false, mailSent: false, lastOk: jetzt, lastFail: st.lastFail || null, lastError: null, since: null };
    await setStatus('ki_waechter', neu);
    await setStatus('ki_stoerung', false);
    if (warStoerung && st.mailSent) {
      await mail('RhetorIQ: Entwarnung, die KI läuft wieder',
        `Hallo Lorena\n\nDie KI-Erzeugung antwortet wieder (Störung seit ${st.since || 'unbekannt'}, Entwarnung um ${jetzt}).\n\nNächster Schritt laut Notfallkarte: auf der Seite Nutzung den Selbsttest nach Störung ausführen und den Hinweis in der Plattform prüfen.\n\nRhetorIQ`)
        .catch(e => console.error('[ki-waechter] Entwarnungsmail fehlgeschlagen:', e.message));
    }
    return { ok: true, entwarnung: warStoerung };
  }

  const fails = (st.fails || 0) + 1;
  const neu = { fails, stoerung: fails >= SCHWELLE, mailSent: !!st.mailSent, lastOk: st.lastOk || null, lastFail: jetzt, lastError: fehler, since: st.since || null };
  let alarm = false;
  if (fails >= SCHWELLE) {
    if (!st.stoerung) neu.since = jetzt;
    if (!st.mailSent) {
      try {
        await mail('RhetorIQ: Die KI-Erzeugung ist gestört',
          `Hallo Lorena\n\nDie KI hat dreimal in Folge nicht geantwortet (letzte Meldung: ${fehler}).\n\nIn der Plattform steht jetzt für alle ein Hinweis. Prüfe als Nächstes die Statusseite status.anthropic.com und das Guthaben im Anthropic-Konto. Mit dem Schalter «Reservekonto erzwingen» auf der Seite Nutzung kannst du ohne Deploy auf das zweite Konto wechseln, falls eines eingerichtet ist.\n\nDiese Mail kommt einmal pro Störung.\n\nRhetorIQ`);
        neu.mailSent = true; alarm = true;
      } catch (e) { console.error('[ki-waechter] Alarmmail fehlgeschlagen:', e.message); }
    }
  }
  await setStatus('ki_waechter', neu);
  if (neu.stoerung) await setStatus('ki_stoerung', true);
  return { ok: false, fails, stoerung: neu.stoerung, alarm };
}

module.exports = { runWaechter, pingKi, SCHWELLE };
