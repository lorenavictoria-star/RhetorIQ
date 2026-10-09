// Stimmprofil als Word-Dokument (Ergebnis des Stimm-Audits), erzeugt aus den vorhandenen Daten ohne KI-Aufruf.
const { pool } = require('../db');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx');
const cp = require('./commProfile');

const HELP = {
  klarheit: 'Eindeutige, klare Aussagen ohne Umwege.',
  waerme: 'Persönlich und zugewandt, mit spürbarem Interesse am Gegenüber.',
  direktheit: 'Kommt schnell zum Punkt und spricht die Lesenden direkt an.',
  verstaendlichkeit: 'Einfache Wörter, wenig Fachsprache und Floskeln.',
  kuerze: 'Knappe Sätze und Absätze.',
  verbindlichkeit: 'Klare Zusagen, Fristen und Verantwortung.'
};

function bar(v) { const n = Math.round((v || 0) / 10); return '█'.repeat(n) + '░'.repeat(10 - n); }
const FONT = 'Arial';
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 120 : o.after }, alignment: o.align, children: [new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, color: o.color })] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 80 }, indent: { left: 360, hanging: 240 }, children: [new TextRun({ text: '•  ' + t, font: FONT, size: 22 })] });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, w, o = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: o.head ? { fill: 'E8E1CF', type: ShadingType.CLEAR } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), font: o.mono ? 'Courier New' : FONT, size: 20, bold: !!o.head })] })]
  });
}

function summarize(profile) {
  const now = profile.latest && profile.latest.scores, tgt = profile.target && profile.target.scores;
  if (!now) return null;
  const rows = profile.dims.map(d => ({ key: d.key, label: d.label, now: now[d.key] || 0, tgt: tgt ? (tgt[d.key] || 0) : null }));
  let match = null, biggest = null, best = null;
  if (tgt) {
    const diffs = rows.map(r => ({ ...r, diff: r.now - r.tgt }));
    match = Math.round(100 - diffs.reduce((s, r) => s + Math.abs(r.diff), 0) / diffs.length);
    biggest = diffs.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];
    best = diffs.slice().sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0];
  }
  return { rows, match, biggest, best };
}

async function buildReport(clientId) {
  const { rows: cr } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  if (!cr[0]) throw new Error('Klient nicht gefunden.');
  const profile = await cp.getProfile(clientId);
  if (!profile.baseline) throw new Error('Für diesen Klienten gibt es noch keine Ausgangslage. Bitte zuerst die Texte auswerten.');
  const sum = summarize(profile);
  const { rows: bv } = await pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type='brand_voice'`, [clientId]);
  const brandVoice = bv[0] && bv[0].content ? String(bv[0].content).trim() : '';
  const base = profile.baseline, m = (profile.latest && profile.latest.metrics) || base.metrics || {};
  const date = new Date().toLocaleDateString('de-CH', { day: '2-digit', month: 'long', year: 'numeric' });
  const kids = [];

  kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Stimmprofil', font: FONT, size: 52, bold: true })] }));
  kids.push(p(cr[0].name, { size: 30, after: 60 }));
  kids.push(p(`Stimm-Audit von Lorena Lienhard · ${date}`, { size: 20, color: '777777', after: 240 }));

  kids.push(h1('1. Das Wichtigste'));
  if (sum && sum.match != null) {
    kids.push(p(`Ihr Ausgangswert «Klingt wie ich»: ${sum.match} Prozent Übereinstimmung mit Ihrer Ziel-Stimme.`, { bold: true, size: 26 }));
    kids.push(p(`Am nächsten am Ziel sind Sie bei «${sum.best.label}». Der grösste Abstand liegt bei «${sum.biggest.label}»: Heute ${sum.biggest.now}, Ziel ${sum.biggest.tgt}.`));
  } else {
    kids.push(p('Für Ihre Texte liegt ein Ausgangswert vor. Ein Ziel aus Ihrer Brand Voice wird im Workshop festgelegt.'));
  }
  kids.push(p(`Grundlage sind ${base.text_count || 'Ihre'} Texte, ausgewertet am ${new Date(base.created_at).toLocaleDateString('de-CH')}.`));

  kids.push(h1('2. Ihr Stil auf einen Blick'));
  const widths = [2200, 1100, 1100, 1100, 3500];
  kids.push(new Table({
    width: { size: 9000, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ children: ['Merkmal', 'Heute', 'Ziel', 'Abstand', 'Heute (Balken)'].map((t, i) => cell(t, widths[i], { head: true })) }),
      ...sum.rows.map(r => new TableRow({ children: [
        cell(r.label, widths[0]), cell(r.now, widths[1]), cell(r.tgt == null ? '–' : r.tgt, widths[2]),
        cell(r.tgt == null ? '–' : (r.now - r.tgt > 0 ? '+' : '') + (r.now - r.tgt), widths[3]), cell(bar(r.now), widths[4], { mono: true })
      ] }))
    ]
  }));
  kids.push(p('', { after: 60 }));
  kids.push(p('Was die Merkmale bedeuten:', { bold: true }));
  profile.dims.forEach(d => kids.push(bullet(`${d.label}: ${HELP[d.key] || ''}`)));
  kids.push(p('Die Werte sind eine Einschätzung auf einer Skala von 0 bis 100. Ein höherer Wert heisst: stärker ausgeprägt.', { size: 20, color: '777777' }));

  kids.push(h1('3. Die drei wichtigsten Befunde'));
  const findings = (profile.latest && profile.latest.findings) || base.findings || [];
  if (findings.length) findings.forEach((f, i) => { kids.push(p(`${i + 1}. ${f.title}`, { bold: true, after: 40 })); kids.push(p(f.detail)); });
  else kids.push(p('Es liegen noch keine Befunde vor.'));

  kids.push(h1('4. Zahlen und typische Wendungen'));
  if (m.avgSentenceLength != null) {
    kids.push(p(`Durchschnittliche Satzlänge: ${m.avgSentenceLength} Wörter. ${m.longSentenceShare} Prozent der Sätze sind länger als 25 Wörter.`));
    kids.push(p('Als Richtwert gelten Sätze mit höchstens 20 Wörtern als gut lesbar.', { size: 20, color: '777777' }));
  }
  if (m.topPhrases && m.topPhrases.length) {
    kids.push(p('Wendungen, die oft wiederkehren:', { bold: true, after: 60 }));
    m.topPhrases.forEach(t => kids.push(bullet(`«${t.phrase}», ${t.count} Mal`)));
  } else kids.push(p('Es gibt keine auffällig häufigen Wendungen.'));

  kids.push(h1('5. Ihre Brand Voice'));
  kids.push(p(brandVoice
    ? brandVoice.slice(0, 1800) + (brandVoice.length > 1800 ? ' …' : '')
    : 'Die Brand Voice entsteht im Workshop oder wird mit Ihren Texten in der Plattform erzeugt. Sie fliesst danach in jeden Text ein.'));

  kids.push(h1('6. So geht es weiter'));
  kids.push(bullet('Paket Stimme (CHF 190 pro Monat): 40 Texte, 2 Überarbeitungen durch Lorena, Antwort innert 1 Werktag. Die ersten 30 Tage mit 40 Texten sind im Audit inbegriffen.'));
  kids.push(bullet('Team (CHF 590) oder Business (CHF 1’490): Workshop «Die Stimme finden» (CHF 3’900 oder 5’000). Die CHF 950 des Audits werden angerechnet.'));
  kids.push(bullet('Rückblick: Nach zwei Wochen messen wir erneut und sehen, wie sich Ihre Werte dem Ziel nähern.'));

  kids.push(h1('7. Methode und Grenzen'));
  kids.push(p('Satzlänge und Wendungen werden exakt gezählt. Die sechs Stilwerte sind eine Einschätzung einer KI mit immer gleichem Auftrag, damit spätere Messungen vergleichbar bleiben. Sie ersetzen kein persönliches Urteil. Die Auswertung beruht nur auf den eingereichten Texten.', { size: 20, color: '555555' }));

  const doc = new Document({
    creator: 'Lorena Lienhard', title: `Stimmprofil ${cr[0].name}`, ...require('./kiHinweis').docMeta(),
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } }, children: kids }]
  });
  return { buffer: await Packer.toBuffer(doc), name: cr[0].name, match: sum && sum.match };
}

module.exports = { buildReport, summarize };
