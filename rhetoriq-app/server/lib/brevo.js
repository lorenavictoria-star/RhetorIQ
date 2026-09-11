const https = require('https');

// Shared Brevo transactional email sender, used across routes and jobs.
async function brevoSend({ to, subject, text, senderName = 'RhetorIQ' }) {
  const apiKey = process.env.BREVO_API_KEY;
  // Failing loudly here matters: a silent return used to make every caller
  // (including the welcome-email flow) look like it succeeded — the advisor
  // saw "E-Mail gesendet" and the client never got anything, with nothing
  // in the logs pointing at a missing/misconfigured API key.
  if (!apiKey) {
    console.error('[brevo] BREVO_API_KEY missing — email not sent');
    throw new Error('E-Mail-Versand ist nicht konfiguriert (BREVO_API_KEY fehlt).');
  }

  const payload = JSON.stringify({
    sender: { name: senderName, email: process.env.SMTP_FROM || 'contact@lorenalienhard.ch' },
    to: [{ email: to }],
    subject,
    textContent: text
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Brevo API ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { brevoSend };
