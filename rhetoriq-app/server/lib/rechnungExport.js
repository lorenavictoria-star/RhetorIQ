// Monatliche Ablage der Rechnungen: ZIP mit den PDF-Rechnungen, die im Monat ausgestellt wurden, und zwei Übersichten (CSV) für die Steuern.
// Kommt am 1. jedes Monats per E-Mail an die Beraterin (jobs/rechnungsexport.js) und lässt sich in der Oberfläche herunterladen.
const JSZip = require('jszip');
const { pool } = require('../db');

const ADVISOR_EMAIL = () => process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';
const chf = r => (Number(r || 0) / 100).toFixed(2);
const datum = d => (d ? new Date(d).toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' }) : '');
const csvFeld = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const csv = rows => '﻿' + rows.map(r => r.map(csvFeld).join(';')).join('\r\n') + '\r\n';

function grenzen(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return null;
  const j = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { von: new Date(Date.UTC(j, mo - 1, 1)), bis: new Date(Date.UTC(j, mo, 1)) };
}

function vormonat(jetzt = new Date()) {
  const d = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 1, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function monatsZip(ym) {
  const g = grenzen(ym);
  if (!g) throw new Error('Ungültiger Monat.');
  const rech = await require('./rechnung');
  const sql = (feld) => `SELECT r.*, c.name AS kunde FROM rechnungen r LEFT JOIN clients c ON c.id = r.client_id WHERE r.${feld} >= $1 AND r.${feld} < $2 ORDER BY r.laufnr`;
  const { rows: ausgestellt } = await pool.query(sql('ausgestellt_am'), [g.von, g.bis]);
  const { rows: bezahlt } = await pool.query(sql('bezahlt_am'), [g.von, g.bis]);
  const zip = new JSZip();
  const hinweise = [];
  let e = null;
  try { e = await rech.holeEinstellungen(); } catch { e = null; }
  const pdfBereit = e && e.name && e.iban;
  if (!pdfBereit && ausgestellt.length) hinweise.push('Die PDF-Rechnungen fehlen: Die Absenderangaben oder die IBAN sind in den Rechnungseinstellungen nicht hinterlegt.');
  const kopf = ['Nummer', 'Ausgestellt am', 'Kunde', 'Posten', 'Beschreibung', 'Betrag CHF', 'Status', 'Gesendet am', 'Bezahlt am'];
  const zeilen = [kopf];
  let summe = 0;
  for (const r of ausgestellt) {
    if (r.status !== 'storniert') summe += Number(r.betrag_rappen || 0);
    zeilen.push([r.nummer, datum(r.ausgestellt_am), r.kunde, r.posten, r.beschreibung, chf(r.betrag_rappen), r.status, datum(r.gesendet_am), datum(r.bezahlt_am)]);
    if (pdfBereit) {
      try { zip.file(`Rechnung_${r.nummer}.pdf`, await rech.pdfErzeugen(r, e)); }
      catch (err) { hinweise.push(`PDF für ${r.nummer} konnte nicht erzeugt werden.`); }
    }
  }
  if (ausgestellt.length) zeilen.push(['Summe ohne stornierte', '', '', '', '', chf(summe), '', '', '']);
  zip.file(`Rechnungen_${ym}.csv`, csv(zeilen));
  const zz = [['Nummer', 'Kunde', 'Bezahlt am', 'Betrag CHF', 'Ausgestellt am']];
  let eing = 0;
  for (const r of bezahlt) { eing += Number(r.betrag_rappen || 0); zz.push([r.nummer, r.kunde, datum(r.bezahlt_am), chf(r.betrag_rappen), datum(r.ausgestellt_am)]); }
  if (bezahlt.length) zz.push(['Summe', '', '', chf(eing), '']);
  zip.file(`Zahlungseingaenge_${ym}.csv`, csv(zz));
  if (hinweise.length) zip.file('HINWEIS.txt', hinweise.join('\n') + '\n');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, ausgestellt: ausgestellt.length, bezahlt: bezahlt.length, summeRappen: summe, eingangRappen: eing, hinweise };
}

// Am 1. des Monats: ZIP des Vormonats per E-Mail an die Beraterin. Ein Monat wird nur einmal verschickt.
async function sendeMonatsablage(ym = vormonat()) {
  const betreff = `Rechnungen ${ym} zur Ablage`;
  try {
    await pool.query('ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS attachments JSONB');
    const { rows } = await pool.query(`SELECT id FROM email_outbox WHERE kind='rechnungen_monat' AND subject=$1 LIMIT 1`, [betreff]);
    if (rows[0]) return { uebersprungen: true };
  } catch { /* ohne Prüfung weiter, lieber doppelt als gar nicht */ }
  const z = await monatsZip(ym);
  const text = [
    'Hallo Lorena', '',
    `Hier die Rechnungen für ${ym} zur Ablage in deinem Ordner und für die Steuern.`, '',
    `Ausgestellt: ${z.ausgestellt} Rechnung${z.ausgestellt === 1 ? '' : 'en'}, Summe CHF ${chf(z.summeRappen)}.`,
    `Zahlungseingänge im Monat: ${z.bezahlt}, Summe CHF ${chf(z.eingangRappen)}.`, '',
    'Im Anhang: die PDF-Rechnungen, die Übersicht der Rechnungen und die Übersicht der Zahlungseingänge als CSV.',
    ...(z.hinweise.length ? ['', 'Hinweise:', ...z.hinweise.map(h => '- ' + h)] : [])
  ].join('\n');
  await require('./emailOutbox').queueEmail({ kind: 'rechnungen_monat', to: ADVISOR_EMAIL(), subject: betreff, text,
    attachments: [{ name: `Rechnungen_${ym}.zip`, contentBase64: z.buffer.toString('base64') }] });
  return { gesendet: true, ym, ausgestellt: z.ausgestellt, bezahlt: z.bezahlt };
}

module.exports = { monatsZip, sendeMonatsablage, vormonat, grenzen };
