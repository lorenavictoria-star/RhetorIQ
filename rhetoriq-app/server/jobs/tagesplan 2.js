// Tagesplan: jeden Tag um 07:00 (Europe/Zurich) per Mail mit Kalenderdatei. Abschaltbar mit TAGESPLAN=aus.
// Einmal pro Tag und Beraterin: die Reservierung in tagesplan_versand wird VOR dem Senden angelegt, so gibt es nie einen zweiten Versand.
// An freien Tagen (Wochenende, Feiertag, Ferien) geht nur eine Mail hinaus, wenn Dringliches oder Enterprise ansteht.
const { pool } = require('../db');
const Z = require('../lib/zeit');
const D = require('../lib/tagesplanDaten');
const { baueIcs } = require('../lib/ics');

function mailText(plan) {
  return `Guten Morgen Lorena\n\nDein Plan für ${Z.datumLang(plan.datum)}:\n\n${plan.text}\n\nDie Kalenderdatei im Anhang enthält alle Einträge mit Uhrzeit und Link zum Arbeitsbereich.\n\nRhetorIQ`;
}

async function runTagesplanJob(opts = {}) {
  if (String(process.env.TAGESPLAN || '').toLowerCase() === 'aus') { console.log('[tagesplan] abgeschaltet (TAGESPLAN=aus)'); return { status: 'aus' }; }
  const jetzt = opts.jetzt || new Date();
  const datum = opts.datum || Z.heute(jetzt);
  await D.ensureSchema();
  const { rows } = await pool.query(`SELECT id FROM users WHERE role='advisor' ORDER BY id LIMIT 1`);
  if (!rows[0]) return { status: 'keine Beraterin' };
  const aid = rows[0].id;
  const plan = await D.planFuer(aid, datum, jetzt);
  if (plan.leer) { console.log('[tagesplan] nichts zu planen, keine Mail'); return { status: 'leer', plan }; }
  if (!opts.erzwingen) {
    try { await pool.query(`INSERT INTO tagesplan_versand (advisor_id, datum, status) VALUES ($1,$2,'reserviert')`, [aid, datum]); }
    catch { return { status: 'schon gesendet', plan }; }
  }
  const { brevoSend } = require('../lib/brevo');
  const { advisorEmails } = require('../lib/notify');
  const ics = baueIcs(D.planEreignisse(plan, { jetzt }), { jetzt });
  const betreff = `Tagesplan ${Z.datumLang(datum)}`;
  let fehler = 0;
  for (const to of advisorEmails()) {
    try { await brevoSend({ to, subject: betreff, text: mailText(plan), senderName: 'RhetorIQ', attachments: [{ name: 'tagesplan.ics', contentBase64: Buffer.from(ics, 'utf8').toString('base64') }] }); }
    catch (e) { fehler++; console.error('[tagesplan] Mail an', to, 'fehlgeschlagen:', e.message); }
  }
  if (!opts.erzwingen) await pool.query(`UPDATE tagesplan_versand SET status=$3 WHERE advisor_id=$1 AND datum=$2`, [aid, datum, fehler ? 'fehler' : 'gesendet']).catch(() => {});
  return { status: fehler ? 'fehler' : 'gesendet', plan };
}

module.exports = { runTagesplanJob, mailText };
