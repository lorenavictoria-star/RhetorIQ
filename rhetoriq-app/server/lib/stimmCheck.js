// Monatlicher Stimmen-Check als Word-Bericht: Verlauf des Stilprofils seit der Ausgangslage, ohne KI-Aufruf.
const { pool } = require('../db');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx');
const cp = require('./commProfile');

const FONT = 'Arial';
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 120 : o.after }, children: [new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, color: o.color })] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 80 }, indent: { left: 360, hanging: 240 }, children: [new TextRun({ text: '•  ' + t, font: FONT, size: 22 })] });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, w, head) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: head ? { fill: 'E8E1CF', type: ShadingType.CLEAR } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), font: FONT, size: 20, bold: !!head })] })]
  });
}

const signed = n => (n > 0 ? '+' : '') + n;
// Übereinstimmung in Prozent: 100 minus durchschnittlicher Abstand zum Ziel (wie in stimmReport.summarize)
function matchOf(scores, tgt, dims) {
  if (!scores || !tgt) return null;
  return Math.round(100 - dims.reduce((s, d) => s + Math.abs((scores[d.key] || 0) - (tgt[d.key] || 0)), 0) / dims.length);
}

// Reine Zahlen: Ausgangslage, letzte Messung (die davor), heute
function compare(profile) {
  const dims = profile.dims, tgt = profile.target && profile.target.scores;
  const base = profile.baseline;
  const snaps = profile.snapshots || [];
  const now = profile.latest || base;
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : (snaps.length === 1 ? base : null);
  const rows = dims.map(d => {
    const b = base.scores[d.key] || 0, n = now.scores[d.key] || 0;
    return { key: d.key, label: d.label, base: b, prev: prev ? (prev.scores[d.key] || 0) : null, now: n, tgt: tgt ? (tgt[d.key] || 0) : null, change: n - b };
  });
  const mNow = matchOf(now.scores, tgt, dims), mBase = matchOf(base.scores, tgt, dims), mPrev = prev ? matchOf(prev.scores, tgt, dims) : null;
  return { rows, prev, now, base, mNow, mBase, mPrev, measured: snaps.length > 0 };
}

// Ein Satz aus den Zahlen, regelbasiert
function meaning(c) {
  if (!c.measured) return 'Es liegt erst die Ausgangslage vor. Nach der nächsten Messung sehen Sie hier, ob Ihre Texte dem Ziel näher kommen.';
  if (c.mNow == null) return 'Ohne hinterlegtes Ziel lässt sich der Abstand nicht beurteilen. Die Veränderung seit der Ausgangslage sehen Sie in der Tabelle.';
  const gain = c.mNow - c.mBase;
  const step = c.mPrev == null ? 0 : c.mNow - c.mPrev;
  const worst = c.rows.slice().sort((a, b) => Math.abs(b.now - b.tgt) - Math.abs(a.now - a.tgt))[0];
  const rest = Math.abs(worst.now - worst.tgt) >= 5 ? ` Am meisten Spielraum gibt es bei «${worst.label}» (heute ${worst.now}, Ziel ${worst.tgt}).` : ' Alle Merkmale liegen nah am Ziel.';
  if (c.mNow >= 90) return `Ihre Texte klingen sehr nah an Ihrer Ziel-Stimme (${c.mNow} Prozent).` + rest;
  if (gain >= 5 && step >= 0) return `Ihre Texte kommen dem Ziel näher: ${signed(gain)} Prozentpunkte seit der Ausgangslage.` + rest;
  if (step <= -3) return `Seit der letzten Messung hat sich die Übereinstimmung um ${Math.abs(step)} Prozentpunkte verringert.` + rest + ' Es lohnt sich, die zuletzt verwendeten Texte gemeinsam anzusehen.';
  if (gain > 0) return `Die Übereinstimmung steigt langsam (${signed(gain)} Prozentpunkte seit der Ausgangslage).` + rest;
  return 'Die Übereinstimmung ist seit der Ausgangslage etwa gleich geblieben.' + rest;
}

function phraseChange(cur, old) {
  const out = [];
  const oldMap = new Map(((old && old.topPhrases) || []).map(t => [t.phrase, t.count]));
  ((cur && cur.topPhrases) || []).forEach(t => {
    const o = oldMap.get(t.phrase);
    out.push(`«${t.phrase}», ${t.count} Mal` + (o == null ? ' (neu)' : o === t.count ? ' (unverändert)' : ` (vorher ${o} Mal)`));
  });
  return out;
}

async function buildCheck(clientId) {
  const { rows: cr } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  if (!cr[0]) throw new Error('Klient nicht gefunden.');
  const profile = await cp.getProfile(clientId);
  if (!profile.baseline) throw new Error('Für diesen Klienten gibt es noch keine Ausgangslage. Bitte zuerst die Texte auswerten.');
  const c = compare(profile);
  const month = new Date().toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Stimmen-Check', font: FONT, size: 52, bold: true })] }));
  kids.push(p(cr[0].name, { size: 30, after: 60 }));
  kids.push(p(`${month} · Stimm-Audit von Lorena Lienhard`, { size: 20, color: '777777', after: 240 }));

  kids.push(h1('1. Das Wichtigste'));
  if (c.mNow != null) {
    kids.push(p(`Übereinstimmung mit Ihrer Ziel-Stimme heute: ${c.mNow} Prozent.`, { bold: true, size: 26 }));
    kids.push(bullet(`Ausgangslage: ${c.mBase} Prozent (${signed(c.mNow - c.mBase)} Prozentpunkte)`));
    if (c.mPrev != null) kids.push(bullet(`Letzte Messung: ${c.mPrev} Prozent (${signed(c.mNow - c.mPrev)} Prozentpunkte)`));
  } else kids.push(p('Für diesen Klienten ist noch kein Ziel hinterlegt. Die Veränderung der Merkmale sehen Sie unten.'));
  kids.push(p(`Heutiger Stand: Messung vom ${new Date(c.now.created_at).toLocaleDateString('de-CH')}, ${c.now.text_count || 'mehrere'} Texte.`, { size: 20, color: '777777' }));

  kids.push(h1('2. Was das bedeutet'));
  kids.push(p(meaning(c)));

  kids.push(h1('3. Die Merkmale im Verlauf'));
  const w = [1900, 1200, 1200, 1100, 1100, 1300];
  kids.push(new Table({
    width: { size: 7800, type: WidthType.DXA }, columnWidths: w,
    rows: [
      new TableRow({ children: ['Merkmal', 'Ausgangslage', 'Letzte Messung', 'Heute', 'Ziel', 'Veränderung'].map((t, i) => cell(t, w[i], true)) }),
      ...c.rows.map(r => new TableRow({ children: [
        cell(r.label, w[0]), cell(r.base, w[1]), cell(r.prev == null ? '–' : r.prev, w[2]), cell(r.now, w[3]),
        cell(r.tgt == null ? '–' : r.tgt, w[4]), cell(c.measured ? signed(r.change) : '–', w[5])
      ] }))
    ]
  }));
  kids.push(p('', { after: 40 }));
  kids.push(p('Skala von 0 bis 100. Die Veränderung vergleicht heute mit der Ausgangslage.', { size: 20, color: '777777' }));

  kids.push(h1('4. Die Befunde der letzten Messung'));
  const findings = c.now.findings || [];
  if (findings.length) findings.forEach((f, i) => { kids.push(p(`${i + 1}. ${f.title}`, { bold: true, after: 40 })); kids.push(p(f.detail)); });
  else kids.push(p('Es liegen keine Befunde vor.'));

  kids.push(h1('5. Satzlänge und Wendungen'));
  const mn = c.now.metrics || {}, mb = c.base.metrics || {};
  if (mn.avgSentenceLength != null) {
    const d = mb.avgSentenceLength != null ? Math.round((mn.avgSentenceLength - mb.avgSentenceLength) * 10) / 10 : null;
    kids.push(p(`Durchschnittliche Satzlänge: ${mn.avgSentenceLength} Wörter` + (d == null ? '.' : ` (Ausgangslage ${mb.avgSentenceLength}, Veränderung ${signed(d)}).`)));
    if (mn.longSentenceShare != null) kids.push(p(`Anteil Sätze über 25 Wörter: ${mn.longSentenceShare} Prozent` + (mb.longSentenceShare != null ? ` (Ausgangslage ${mb.longSentenceShare} Prozent).` : '.')));
    kids.push(p('Als Richtwert gelten Sätze mit höchstens 20 Wörtern als gut lesbar.', { size: 20, color: '777777' }));
  }
  const ph = phraseChange(mn, mb);
  if (ph.length) { kids.push(p('Wendungen, die oft wiederkehren:', { bold: true, after: 60 })); ph.forEach(t => kids.push(bullet(t))); }
  else kids.push(p('Es gibt keine auffällig häufigen Wendungen.'));

  kids.push(h1('6. Methode und Grenzen'));
  kids.push(p('Satzlänge und Wendungen werden exakt gezählt. Die sechs Stilwerte sind eine Einschätzung einer KI mit immer gleichem Auftrag, damit die Messungen vergleichbar bleiben. Sie ersetzen kein persönliches Urteil.', { size: 20, color: '555555' }));

  const doc = new Document({
    creator: 'Lorena Lienhard', title: `Stimmen-Check ${cr[0].name}`, ...require('./kiHinweis').docMeta(),
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } }, children: kids }]
  });
  return { buffer: await Packer.toBuffer(doc), name: cr[0].name, match: c.mNow };
}

module.exports = { buildCheck, compare, meaning };
