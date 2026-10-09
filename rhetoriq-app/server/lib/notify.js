// Empfänger für Warnungen an die Beraterin: Hauptadresse und optional eine zweite (ADVISOR_NOTIFY_EMAIL_2).
function advisorEmails() {
  const list = [process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch', process.env.ADVISOR_NOTIFY_EMAIL_2]
    .map(x => (x || '').trim()).filter(Boolean);
  return [...new Set(list)];
}

// Warnung an alle Empfänger senden; wirft nie
async function mailAdvisor(subject, text) {
  const { brevoSend } = require('./brevo');
  for (const to of advisorEmails()) {
    try { await brevoSend({ to, subject, text, senderName: 'RhetorIQ' }); }
    catch (e) { console.error('[notify] Mail an', to, 'fehlgeschlagen:', e.message); }
  }
}

module.exports = { advisorEmails, mailAdvisor };
