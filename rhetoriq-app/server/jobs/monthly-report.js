const { pool } = require('../db');
const { brevoSend: brevoSendShared } = require('../lib/brevo');

const ADVISOR_EMAIL = process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';

const brevoSend = (opts) => brevoSendShared({ senderName: 'RhetorIQ Reports', ...opts }).catch(e => {
  console.error('[monthly-report] Brevo send failed:', e.message);
});

async function runMonthlyReport() {
  console.log('[monthly-report] Starting…');
  try {
    const now   = new Date();
    const month = now.toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });

    // 1. Total analyses & tokens — last 30 days vs previous 30 days
    const { rows: curr } = await pool.query(`
      SELECT COUNT(*)::int AS calls,
             SUM(ul.input_tokens)::bigint  AS input_tokens,
             SUM(ul.output_tokens)::bigint AS output_tokens
      FROM usage_log ul
      WHERE ul.created_at > NOW() - INTERVAL '30 days'
    `);
    const { rows: prev } = await pool.query(`
      SELECT COUNT(*)::int AS calls
      FROM usage_log
      WHERE created_at BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days'
    `);
    const currData = curr[0] || {};
    const prevCalls = prev[0]?.calls || 0;
    const callDelta = currData.calls - prevCalls;
    const callTrend = callDelta > 0 ? `+${callDelta}` : `${callDelta}`;
    const costEst = (
      ((currData.input_tokens  || 0) / 1_000_000) * 3 +
      ((currData.output_tokens || 0) / 1_000_000) * 15
    ).toFixed(2);

    // 2. Client overview
    const { rows: clients } = await pool.query(`
      SELECT c.name, c.industry,
             COUNT(a.id)::int      AS total_analyses,
             MAX(a.created_at)     AS last_active,
             AVG(CASE WHEN a.user_rating IS NOT NULL THEN a.user_rating END)::numeric(3,2) AS avg_rating,
             BOOL_OR(cm.client_id IS NOT NULL) AS has_brand_voice
      FROM clients c
      LEFT JOIN analyses a ON a.client_id = c.id AND a.created_at > NOW() - INTERVAL '30 days'
      LEFT JOIN company_memory cm ON cm.client_id = c.id
      GROUP BY c.id, c.name, c.industry
      ORDER BY total_analyses DESC NULLS LAST
    `);

    // 3. Module performance — satisfaction rate
    const { rows: modulePerf } = await pool.query(`
      SELECT module_label,
             COUNT(*)::int AS calls,
             SUM(CASE WHEN user_rating =  1 THEN 1 ELSE 0 END)::int AS up,
             SUM(CASE WHEN user_rating = -1 THEN 1 ELSE 0 END)::int AS down,
             SUM(CASE WHEN had_brand_voice THEN 1 ELSE 0 END)::int  AS with_bv
      FROM analyses
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY module_label
      ORDER BY calls DESC
    `);

    // 4. Training examples: curated vs auto-generated
    const { rows: exStats } = await pool.query(`
      SELECT
        SUM(CASE WHEN auto_generated = false THEN 1 ELSE 0 END)::int AS manual,
        SUM(CASE WHEN auto_generated = true  THEN 1 ELSE 0 END)::int AS auto,
        SUM(CASE WHEN auto_generated = true AND rating >= 3 THEN 1 ELSE 0 END)::int AS auto_approved
      FROM module_examples
    `);
    const ex = exStats[0] || {};

    // 5. Inactive clients (no activity last 30 days but had activity before)
    const { rows: inactive } = await pool.query(`
      SELECT c.name, MAX(a.created_at) AS last_seen
      FROM clients c
      JOIN analyses a ON a.client_id = c.id
      WHERE c.id NOT IN (
        SELECT DISTINCT client_id FROM analyses
        WHERE created_at > NOW() - INTERVAL '30 days' AND client_id IS NOT NULL
      )
      GROUP BY c.id, c.name
      ORDER BY last_seen DESC
      LIMIT 5
    `);

    // 6. Brand Voice coverage
    const totalClients = clients.length;
    const bvClients    = clients.filter(c => c.has_brand_voice).length;

    // ── Build report ─────────────────────────────────────────────────────────
    const lines = [
      `RHETORIQ MONATSBERICHT — ${month.toUpperCase()}`,
      '═'.repeat(56),
      '',
      'GESAMTÜBERBLICK (letzte 30 Tage vs. Vormonat):',
      `  Analysen gesamt:    ${currData.calls || 0} (Vormonat: ${prevCalls}, Trend: ${callTrend})`,
      `  Input-Tokens:       ${(currData.input_tokens  || 0).toLocaleString('de-CH')}`,
      `  Output-Tokens:      ${(currData.output_tokens || 0).toLocaleString('de-CH')}`,
      `  Geschätzte Kosten:  USD ${costEst}`,
      `  Aktive Klienten:    ${clients.filter(c => c.total_analyses > 0).length} / ${totalClients}`,
      `  Brand Voice-Abdeckung: ${bvClients} / ${totalClients} Klienten`,
      '',
      'KLIENTEN-ÜBERSICHT:',
    ];

    clients.forEach(c => {
      const lastSeen = c.last_active
        ? new Date(c.last_active).toLocaleDateString('de-CH')
        : 'inaktiv';
      const bv = c.has_brand_voice ? '✓ BV' : '– kein BV';
      lines.push(`  ${c.name}${c.industry ? ' ('+c.industry+')' : ''}`);
      lines.push(`    Analysen: ${c.total_analyses} | Letzter Einsatz: ${lastSeen} | ${bv}`);
    });

    lines.push('', 'MODULE-PERFORMANCE:');
    if (modulePerf.length === 0) {
      lines.push('  Keine Daten.');
    } else {
      modulePerf.forEach(m => {
        const rated = m.up + m.down;
        const sat   = rated > 0 ? Math.round((m.up / rated) * 100) + '%' : 'n/a';
        lines.push(`  ${m.module_label||'—'}: ${m.calls} Calls | Zufriedenheit: ${sat} | BV: ${m.with_bv}`);
      });
    }

    lines.push('', 'TRAININGSBEISPIELE (Gesamtbestand):');
    lines.push(`  Manuell kuratiert:  ${ex.manual || 0}`);
    lines.push(`  Auto-generiert:     ${ex.auto   || 0} (davon freigegeben: ${ex.auto_approved || 0})`);
    if ((ex.auto || 0) - (ex.auto_approved || 0) > 0) {
      lines.push(`  → ${(ex.auto||0) - (ex.auto_approved||0)} Auto-Beispiele noch unbewertet — bitte kuratieren.`);
    }

    if (inactive.length > 0) {
      lines.push('', 'INAKTIVE KLIENTEN (kein Einsatz letzte 30 Tage):');
      inactive.forEach(c => {
        const d = new Date(c.last_seen).toLocaleDateString('de-CH');
        lines.push(`  - ${c.name} (zuletzt: ${d})`);
      });
      lines.push('  → Nachfassen oder Workspace archivieren?');
    }

    lines.push(
      '',
      'WARTUNGS-CHECKLISTE:',
      `  [ ] SW-Cache-Version prüfen (aktuell in sw.js)`,
      `  [ ] Anthropic API Changelog prüfen: https://docs.anthropic.com/en/release-notes/api`,
      `  [ ] Negativ bewertete Analysen der letzten 30 Tage im Wochenbericht prüfen`,
      `  [ ] Trainingsbeispiele mit Rating < 3 löschen oder aufwerten`,
      '',
      '─'.repeat(56),
      'Dieser Bericht wird automatisch am 1. jeden Monats um 08:00 generiert.',
      'RhetorIQ · contact@lorenalienhard.ch'
    );

    const reportText = lines.join('\n');

    await brevoSend({
      to: ADVISOR_EMAIL,
      subject: `RhetorIQ Monatsbericht — ${month}`,
      text: reportText
    });

    console.log(`[monthly-report] Sent to ${ADVISOR_EMAIL}`);
  } catch (e) {
    console.error('[monthly-report] Error:', e.message);
  }
}

module.exports = { runMonthlyReport };
