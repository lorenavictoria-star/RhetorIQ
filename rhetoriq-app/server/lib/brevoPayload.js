// Baut den Brevo-Inhalt. attachments: [{ name, contentBase64 }] (optional, zum Beispiel Excel-Liste).
function buildPayload({ to, subject, text, senderName, attachments }) {
  const payload = {
    sender: { name: senderName, email: process.env.SMTP_FROM || 'contact@lorenalienhard.ch' },
    to: [{ email: to }],
    subject,
    textContent: text
  };
  if (Array.isArray(attachments) && attachments.length) {
    payload.attachment = attachments.map(a => ({ name: a.name, content: a.contentBase64 }));
  }
  return payload;
}

module.exports = { buildPayload };
