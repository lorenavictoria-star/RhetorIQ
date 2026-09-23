const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One raw attempt against the Brevo API — no retry logic here, that lives in
// brevoSend() below so callers always get the retried, resilient behavior.
function brevoSendOnce({ to, subject, text, senderName }) {
  const apiKey = process.env.BREVO_API_KEY;
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
      },
      timeout: 15000
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          const err = new Error(`Brevo API ${res.statusCode}: ${body}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Brevo request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Shared Brevo transactional email sender, used across routes and jobs.
// Retries transient failures (network errors, timeouts, Brevo 5xx/429)
// automatically — a single flaky request should never be the reason an
// email never arrives. A genuine 4xx (bad recipient, missing API key, etc.)
// fails fast since retrying it would never succeed.
async function brevoSend({ to, subject, text, senderName = 'RhetorIQ' }) {
  const delays = [500, 2000]; // 3 attempts total: immediate, +0.5s, +2s
  for (let attempt = 0; ; attempt++) {
    try {
      return await brevoSendOnce({ to, subject, text, senderName });
    } catch (e) {
      const isClientError = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429;
      if (isClientError || attempt >= delays.length) throw e;
      console.error(`[brevo] send attempt ${attempt + 1} failed (${e.message}) — retrying…`);
      await sleep(delays[attempt]);
    }
  }
}

module.exports = { brevoSend };
