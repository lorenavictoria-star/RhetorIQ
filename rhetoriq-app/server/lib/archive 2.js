// Reden-Archiv und Jahresrückblick: alle Reden eines Klienten aus einem Jahr, als Liste und als Word. Keine KI-Aufrufe.
// Reden sind Texte des Text-Generators mit der Textart Rede (feedback_key text-gen-speech).
const { pool } = require('../db');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak
} = require('docx');
const cp = require('./commProfile');

const FONT = 'Arial';

function yearOf(y) {
  const n = parseInt(y, 10);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : new Date().getFullYear();
}

function cleanLine(s) {
  return String(s || '').replace(/^[\s#>*_\-]+/, '').replace(/[*_`]+/g, '').trim();
}
function titleOf(text) {
  const first = String(text || '').split(/\r?\n/).map(cleanLine).find(l => l.length > 0) || 'Rede ohne Titel';
  return first.length > 90 ? first.slice(0, 87).trimEnd() + '…' : first;
}
function wordCount(text) { return (String(text || '').match(/\S+/g) || []).length; }

async function listReden(clientId, year) {
  const y = yearOf(year);
  const from = new Date(Date.UTC(y, 0, 1)).toISOString(), to = new Date(Date.UTC(y + 1, 0, 1)).toISOString();
  const { rows } = await pool.query(
    `SELECT id, result, created_at FROM analyses
     WHERE client_id=$1 AND result IS NOT NULL AND created_at >= $2 AND created_at < $3
       AND (feedback_key='text-gen-speech' OR (module='text-gen' AND module_label ILIKE '%Rede%'))
     ORDER BY created_at DESC`, [clientId, from, to]);
  return { year: y, reden: rows.map(r => ({ id: r.id, date: r.created_at, title: titleOf(r.result), words: wordCount(r.result), text: r.result })) };
}

async function listYears(clientId) {
  const { rows } = await pool.query(
    `SELECT created_at FROM analyses WHERE client_id=$1 AND result IS NOT NULL
       AND (feedback_key='text-gen-speech' OR (module='text-gen' AND module_label ILIKE '%Rede%'))`, [clientId]);
  const ys = new Set(rows.map(r => new Date(r.created_at).getUTCFullYear()));
  ys.add(new Date().getFullYear());
  return [...ys].sort((a, b) => b - a);
}

const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 120 : o.after, line: o.line }, alignment: o.align, children: [new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, color: o.color })] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 140 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 80 }, indent: { left: 360, hanging: 240 }, children: [new TextRun({ text: '•  ' + t, font: FONT, size: 22 })] });
const fmtDate = d => new Date(d).toLocaleDateString('de-CH', { day: '2-digit', month: 'long', year: 'numeric' });

async function buildRueckblick(clientId, year) {
  const { rows: cr } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  if (!cr[0]) throw new Error('Klient nicht gefunden.');
  const { year: y, reden } = await listReden(clientId, year);
  const chrono = reden.slice().reverse(); // im Buch von Januar bis Dezember
  const kids = [];

  kids.push(new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: 'Reden-Archiv und Jahresrückblick', font: FONT, size: 56, bold: true })] }));
  kids.push(p(`${cr[0].name}, ${y}`, { size: 32, after: 120 }));
  kids.push(p(`Zusammengestellt am ${fmtDate(new Date())} von Lorena Lienhard`, { size: 20, color: '777777', after: 0 }));
  kids.push(new Paragraph({ children: [new PageBreak()] }));

  kids.push(h1('Inhaltsverzeichnis'));
  if (!chrono.length) kids.push(p(`Für ${y} sind keine Reden archiviert.`));
  chrono.forEach((r, i) => kids.push(p(`${i + 1}.  ${r.title}  (${new Date(r.date).toLocaleDateString('de-CH')}, ${r.words} Wörter)`, { after: 60 })));
  kids.push(p('Statistik zum Jahr', { bold: true, after: 60 }));
  kids.push(new Paragraph({ children: [new PageBreak()] }));

  chrono.forEach((r, i) => {
    kids.push(h1(`${i + 1}. ${r.title}`));
    kids.push(p(fmtDate(r.date) + ` · ${r.words} Wörter`, { size: 20, color: '777777', after: 200 }));
    String(r.text).split(/\r?\n/).forEach(line => kids.push(p(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''), { after: line.trim() ? 120 : 40, line: 300 })));
    kids.push(new Paragraph({ children: [new PageBreak()] }));
  });

  kids.push(h1(`Statistik ${y}`));
  const total = chrono.reduce((s, r) => s + r.words, 0);
  kids.push(bullet(`Anzahl Reden: ${chrono.length}`));
  if (chrono.length) {
    const avg = Math.round(total / chrono.length);
    kids.push(bullet(`Durchschnittliche Länge: ${avg} Wörter (etwa ${Math.max(1, Math.round(avg / 125))} Minuten Redezeit)`));
    kids.push(bullet(`Längste Rede: ${Math.max(...chrono.map(r => r.words))} Wörter, kürzeste: ${Math.min(...chrono.map(r => r.words))} Wörter`));
    const m = cp.computeMetrics(chrono.map(r => r.text));
    kids.push(bullet(`Durchschnittliche Satzlänge: ${m.avgSentenceLength} Wörter`));
    kids.push(p('Häufigste Wendungen', { bold: true, after: 60 }));
    if (m.topPhrases.length) m.topPhrases.forEach(t => kids.push(bullet(`«${t.phrase}», ${t.count} Mal`)));
    else kids.push(p('Es gibt keine auffällig häufigen Wendungen.'));
  }

  const doc = new Document({
    creator: 'Lorena Lienhard', title: `Reden-Archiv ${cr[0].name} ${y}`,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } }, children: kids }]
  });
  return { buffer: await Packer.toBuffer(doc), name: cr[0].name, year: y, count: chrono.length };
}

module.exports = { listReden, listYears, buildRueckblick, titleOf, wordCount, yearOf };
