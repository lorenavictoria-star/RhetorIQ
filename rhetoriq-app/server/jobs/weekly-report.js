const { pool } = require('../db');
const https = require('https');

const ADVISOR_EMAIL = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';
const REPORT_FROM   = process.env.SMTP_FROM      || 'contact@lorenalienhard.ch';

// ── Brevo send (same helper pattern as clients.js) ───────────────────────────
function brevoSend({ to, subject, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('[weekly-report] BREVO_API_KEY missing'); return Promise.resolve(); }

  const payload = JSON.stringify({
    sender: { name: 'RhetorIQ Reports', email: REPORT_FROM },
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
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Main report function ─────────────────────────────────────────────────────
async function runWeeklyReport() {
  console.log('[weekly-report] Starting…');
  try {
    const now  = new Date();
    const week = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // 1. Total analyses this week (per module)
    const { rows: moduleStats } = await pool.query(`
      SELECT module_label, COUNT(*)::int AS calls,
             SUM(CASE WHEN user_rating = 1 THEN 1 ELSE 0 END)::int AS thumbs_up,
             SUM(CASE WHEN user_rating = -1 THEN 1 ELSE 0 END)::int AS thumbs_down
      FROM analyses
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY module_label
      ORDER BY calls DESC
    `);

    // 2. Token usage & cost estimate this week
    const { rows: tokenRows } = await pool.query(`
      SELECT
        SUM(input_tokens)::bigint  AS total_input,
        SUM(output_tokens)::bigint AS total_output,
        COUNT(*)::int              AS total_calls
      FROM usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const tokens = tokenRows[0] || {};
    // Approximate cost: Sonnet 4.6 = $3/MTok input, $15/MTok output
    const costEst = (
      ((tokens.total_input  || 0) / 1_000_000) * 3 +
      ((tokens.total_output || 0) / 1_000_000) * 15
    ).toFixed(2);

    // 3. Active clients this week
    const { rows: clientRows } = await pool.query(`
      SELECT c.name, COUNT(a.id)::int AS analyses
      FROM clients c
      JOIN analyses a ON a.client_id = c.id
      WHERE a.created_at > NOW() - INTERVAL '7 days'
      GROUP BY c.name
      ORDER BY analyses DESC
      LIMIT 10
    `);

    // 4. Brand Voice usage rate
    const { rows: bvRows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN had_brand_voice THEN 1 ELSE 0 END)::int AS with_bv
      FROM analyses
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const bv = bvRows[0] || {};
    const bvRate = bv.total > 0
      ? Math.round((bv.with_bv / bv.total) * 100)
      : 0;

    // 5. Low-rated outputs (thumbs down) — needs manual review
    const { rows: lowRated } = await pool.query(`
      SELECT a.module_label, a.created_at, c.name AS client_name,
             LEFT(a.result, 200) AS preview
      FROM analyses a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.user_rating = -1
        AND a.created_at > NOW() - INTERVAL '7 days'
      ORDER BY a.created_at DESC
      LIMIT 5
    `);

    // 6. Auto-generated examples this week (to curate)
    const { rows: autoEx } = await pool.query(`
      SELECT module_key, COUNT(*)::int AS count
      FROM module_examples
      WHERE auto_generated = true
        AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY module_key
      ORDER BY count DESC
    `);

    // ── Build report text ────────────────────────────────────────────────────
    const lines = [
      `RHETORIQ WOCHENBERICHT — ${week}`,
      '═'.repeat(52),
      '',
      'NUTZUNG DIESE WOCHE:',
      `  Analysen gesamt:   ${tokens.total_calls || 0}`,
      `  Input-Tokens:      ${(tokens.total_input  || 0).toLocaleString('de-CH')}`,
      `  Output-Tokens:     ${(tokens.total_output || 0).toLocaleString('de-CH')}`,
      `  Geschätzte Kosten: USD ${costEst}`,
      `  Brand Voice-Rate:  ${bvRate}% der Analysen`,
      '',
      'MODULE-RANKING (diese Woche):',
    ];

    if (moduleStats.length === 0) {
      lines.push('  Keine Aktivität diese Woche.');
    } else {
      moduleStats.forEach((m, i) => {
        const rating = m.thumbs_up || m.thumbs_down
          ? ` | 👍 ${m.thumbs_up} 👎 ${m.thumbs_down}`
          : '';
        lines.push(`  ${i + 1}. ${m.module_label||'Unbekannt'}: ${m.calls} Calls${rating}`);
      });
    }

    lines.push('', 'AKTIVSTE KLIENTEN:');
    if (clientRows.length === 0) {
      lines.push('  Keine Aktivität.');
    } else {
      clientRows.forEach(c => lines.push(`  - ${c.name}: ${c.analyses} Analysen`));
    }

    lines.push('', 'NEU AUTO-GENERIERTE TRAININGSBEISPIELE (zur Kuration):');
    if (autoEx.length === 0) {
      lines.push('  Keine neuen Auto-Beispiele.');
    } else {
      autoEx.forEach(e => lines.push(`  - ${e.module_key}: ${e.count} neue Beispiele`));
      lines.push('  → Bitte unter Einstellungen > Trainingsbeispiele kuratieren (Rating anpassen oder löschen).');
    }

    if (lowRated.length > 0) {
      lines.push('', 'NEGATIV BEWERTET — BITTE PRÜFEN:');
      lowRated.forEach(r => {
        lines.push(`  Modul: ${r.module_label} | Klient: ${r.client_name || '—'}`);
        lines.push(`  Datum: ${new Date(r.created_at).toLocaleString('de-CH')}`);
        lines.push(`  Vorschau: ${r.preview}…`);
        lines.push('');
      });
    }

    lines.push(
      '',
      '─'.repeat(52),
      'Dieser Bericht wird automatisch jeden Montag um 08:00 generiert.',
      'RhetorIQ · contact@lorenalienhard.ch'
    );

    const reportText = lines.join('\n');

    await brevoSend({
      to: ADVISOR_EMAIL,
      subject: `RhetorIQ Wochenbericht — ${week}`,
      text: reportText
    });

    console.log(`[weekly-report] Sent to ${ADVISOR_EMAIL}`);
  } catch (e) {
    console.error('[weekly-report] Error:', e.message);
  }
}

module.exports = { runWeeklyReport };
