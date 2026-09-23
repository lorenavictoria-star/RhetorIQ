const { pool } = require('../db');
const { brevoSend } = require('./brevo');

// Every email that absolutely must arrive (advisor review requests, feedback
// notifications, weekly/monthly reports) goes through here instead of
// calling brevoSend directly. The row is written to email_outbox FIRST —
// before any network call — so the email survives a crash or redeploy even
// if the immediate send attempt below never completes. sweepOutbox() then
// retries anything not yet 'sent', on its own schedule, independent of
// whatever request originally created it.
const MAX_ATTEMPTS = 20; // with the 3-minute sweep this allows ~1h of retrying
                          // before giving up — long enough to survive fixing
                          // a mistaken third-party block (e.g. Brevo's IP
                          // allowlist) without losing the email entirely.
const ALERT_AFTER_MS = 15 * 60 * 1000; // early warning, well before MAX_ATTEMPTS gives up

async function queueEmail({ kind, to, subject, text, senderName = 'RhetorIQ' }) {
  const { rows } = await pool.query(
    `INSERT INTO email_outbox (kind, to_email, subject, body, sender_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [kind, to, subject, text, senderName]
  );
  const id = rows[0].id;
  // Best-effort immediate attempt so delivery is fast in the normal case —
  // failure here is not fatal, sweepOutbox() will pick it up regardless.
  await attemptSend(id).catch(e => console.error(`[email-outbox] immediate send #${id} failed:`, e.message));
  return id;
}

async function attemptSend(id) {
  const { rows } = await pool.query('SELECT * FROM email_outbox WHERE id=$1 AND status != $2', [id, 'sent']);
  const row = rows[0];
  if (!row) return;
  try {
    await brevoSend({ to: row.to_email, subject: row.subject, text: row.body, senderName: row.sender_name });
    await pool.query(`UPDATE email_outbox SET status='sent', sent_at=NOW(), attempts=attempts+1 WHERE id=$1`, [id]);
  } catch (e) {
    const attempts = row.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
    await pool.query(`UPDATE email_outbox SET status=$1, attempts=$2, last_error=$3 WHERE id=$4`, [status, attempts, e.message, id]);
    if (status === 'dead') {
      console.error(`[email-outbox] #${id} (${row.kind} -> ${row.to_email}) gave up after ${attempts} attempts:`, e.message);
      // Sentry (if configured) is a channel independent of email itself —
      // so a total, sustained Brevo outage still surfaces somewhere visible
      // instead of failing completely silently.
      try {
        const Sentry = require('@sentry/node');
        if (process.env.SENTRY_DSN) Sentry.captureException(new Error(`email_outbox dead-letter: ${row.kind} to ${row.to_email} — ${e.message}`));
      } catch {}
    }
    throw e;
  }
}

// Fires once per stuck row, well before MAX_ATTEMPTS gives up — so a
// sustained outage (like a Brevo IP block) is flagged within ~15 minutes via
// Sentry, a channel independent of email itself, instead of only surfacing
// after ~1 hour of silent retries or never at all if nobody happens to check
// the admin endpoint.
async function alertIfStuck() {
  const { rows } = await pool.query(
    `SELECT id, kind, to_email, last_error FROM email_outbox
     WHERE status='pending' AND alerted_at IS NULL AND created_at < NOW() - INTERVAL '15 minutes'`
  );
  for (const row of rows) {
    console.error(`[email-outbox] #${row.id} (${row.kind} -> ${row.to_email}) still pending after 15+ minutes:`, row.last_error);
    try {
      const Sentry = require('@sentry/node');
      if (process.env.SENTRY_DSN) {
        Sentry.captureMessage(`email_outbox stuck 15+ min: ${row.kind} to ${row.to_email} — ${row.last_error}`, 'warning');
      }
    } catch {}
    await pool.query('UPDATE email_outbox SET alerted_at=NOW() WHERE id=$1', [row.id]);
  }
}

// Retries every row that isn't 'sent' or permanently 'dead' yet. Safe to run
// as often as needed — sending an already-'sent' row is impossible since
// attemptSend() re-checks status, and Brevo's own idempotency aside, this
// only ever retries rows that genuinely never got a 2xx response.
async function sweepOutbox() {
  const { rows } = await pool.query(
    `SELECT id FROM email_outbox WHERE status='pending' AND attempts < $1 ORDER BY created_at ASC LIMIT 50`,
    [MAX_ATTEMPTS]
  );
  for (const row of rows) {
    await attemptSend(row.id).catch(() => {}); // already logged inside attemptSend
  }
  if (rows.length) console.log(`[email-outbox] sweep processed ${rows.length} pending row(s)`);
  await alertIfStuck().catch(e => console.error('[email-outbox] alert check failed:', e.message));
}

module.exports = { queueEmail, sweepOutbox, attemptSend };
