const https = require('https');

// Shared Brevo transactional email sender, used across routes and jobs.
async function brevoSend({ to, subject, text, senderName = 'RhetorIQ' }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('[brevo] BREVO_API_KEY missing'); return; }

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
