const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, AlignmentType
} = require('docx');
const { SEKTOR_NAME } = require('./moduleCatalog');

// Erzeugt die Workshop-Mappe in Node (Port von workshop/workshop_docs.py):
//   0_Briefing           neu per npm docx
//   1_Einfuehrungsgespraech, 2_Workshop_Leitfaden, 3_Erfassungsbogen
//                        aus den Vorlagen (templates/workshop) durch XML-Bearbeitung mit jszip
// Die Vorab-Mail gehört nicht dazu (routes/inquiries.js).

const VORLAGEN = path.join(__dirname, '..', 'templates', 'workshop');
const VORLAGE = {
  intro: 'RhetorIQ_Einfuehrungsgespraech.docx',
  leitfaden: 'RhetorIQ_Workshop_Stimme_finden.docx',
  erfassung: 'RhetorIQ_Workshop_Erfassungsbogen.docx'
};

const slug = s => String(s || '').replace(/[^\p{L}\p{N}]/gu, '_').replace(/^_+|_+$/g, '') || 'Klient';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ── XML-Hilfen ──────────────────────────────────────────────
const T_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const P_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function ptext(xml) {
  let out = '';
  for (const m of xml.matchAll(T_RE)) out += unesc(m[1]);
  return out;
}

// Setzt den Text eines Absatzes und behält die Formatierung des ersten Runs.
function setText(pxml, value) {
  const runs = pxml.match(RUN_RE);
  const t = `<w:t xml:space="preserve">${esc(value)}</w:t>`;
  if (!runs) return pxml.replace(/<\/w:p>$/, `<w:r>${t}</w:r></w:p>`);
  let i = 0;
  return pxml.replace(RUN_RE, run => {
    const open = run.match(/^<w:r(?:\s[^>]*)?>/)[0];
    const rpr = (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    const first = i++ === 0;
    return `${open}${rpr}${first ? t : '<w:t xml:space="preserve"></w:t>'}</w:r>`;
  });
}

// Zerlegt den Body in die direkten Kinder (Absätze, Tabellen, sectPr).
function splitBody(xml) {
  const open = xml.indexOf('<w:body>');
  const close = xml.lastIndexOf('</w:body>');
  if (open < 0 || close < 0) throw new Error('Vorlage ohne w:body');
  const start = open + '<w:body>'.length;
  const body = xml.slice(start, close);
  const kids = [];
  const tag = /<(\/?)(w:[A-Za-z0-9]+)(\s[^>]*?)?(\/?)>/g;
  let depth = 0, from = 0, name = '';
  let m;
  while ((m = tag.exec(body))) {
    const closing = m[1] === '/', self = m[4] === '/';
    if (!closing) {
      if (depth === 0) { from = m.index; name = m[2]; }
      if (self) { if (depth === 0) kids.push({ name, xml: body.slice(from, tag.lastIndex) }); }
      else depth++;
    } else {
      depth--;
      if (depth === 0) kids.push({ name, xml: body.slice(from, tag.lastIndex) });
    }
  }
  return { head: xml.slice(0, start), kids, tail: xml.slice(close) };
}
const joinBody = ({ head, kids, tail }) => head + kids.map(k => k.xml).join('') + tail;
const isP = k => k.name === 'w:p';

async function loadTemplate(key) {
  const buf = fs.readFileSync(path.join(VORLAGEN, VORLAGE[key]));
  return JSZip.loadAsync(buf);
}
async function finish(zip) {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// "Alienhard" -> "Lienhard" in allen Textteilen (Dokument, Kopf-, Fusszeile).
async function fixName(zip) {
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    const s = await zip.file(name).async('string');
    if (s.includes('Alienhard')) zip.file(name, s.replace(/Alienhard/g, 'Lienhard'));
  }
}

// ── 1 Einführungsgespräch ───────────────────────────────────
async function intro(cfg) {
  const zip = await loadTemplate('intro');
  let xml = await zip.file('word/document.xml').async('string');
  const parts = splitBody(xml);
  const label = SEKTOR_NAME[cfg.sektor] || '';
  const fill = (k, lab, val) => { if (val) k.xml = setText(k.xml, `${lab} ${val}`); };
  for (const k of parts.kids) {
    if (!isP(k)) continue;
    const t = ptext(k.xml);
    if (t.startsWith('Datum:')) fill(k, 'Datum:', cfg.datum);
    else if (t.startsWith('Klient / Unternehmen:')) fill(k, 'Klient / Unternehmen:', cfg.firma ? (cfg.kontakt ? `${cfg.firma} (${cfg.kontakt})` : cfg.firma) : '');
    else if (t.startsWith('Sektor:')) fill(k, 'Sektor:', label);
  }
  // nur den gewählten Sektorblock behalten
  if (label) {
    const kids = parts.kids;
    const starts = [];
    kids.forEach((k, i) => { if (isP(k) && ptext(k.xml).startsWith('◆')) starts.push(i); });
    const endAll = kids.findIndex(k => isP(k) && ptext(k.xml).trim() === 'Nächste Schritte');
    if (starts.length && endAll > starts[0]) {
      const bounds = [...starts, endAll];
      const drop = new Set();
      for (let j = starts.length - 1; j >= 0; j--) {
        const a = starts[j], b = bounds[j + 1];
        if (!ptext(kids[a].xml).includes(label)) for (let i = a; i < b; i++) drop.add(i);
      }
      parts.kids = kids.filter((_, i) => !drop.has(i));
    }
  }
  // Module vorankreuzen
  const gew = new Set([...(cfg.module || []), 'Brand Voice']);
  let out = joinBody(parts);
  out = out.replace(P_RE, p => {
    const t = ptext(p);
    if (t.startsWith('[ ] ') || t.startsWith('[✓] ')) return setText(p, (gew.has(t.slice(4)) ? '[✓] ' : '[ ] ') + t.slice(4));
    return p;
  });
  zip.file('word/document.xml', out);
  await fixName(zip);
  return finish(zip);
}

// ── 2 Leitfaden ─────────────────────────────────────────────
async function leitfaden(cfg) {
  const zip = await loadTemplate('leitfaden');
  const xml = await zip.file('word/document.xml').async('string');
  const parts = splitBody(xml);
  const pIdx = parts.kids.map((k, i) => (isP(k) ? i : -1)).filter(i => i >= 0);
  if (pIdx.length >= 3) {
    const neu = { name: 'w:p', xml: parts.kids[pIdx[2]].xml };
    const zeile = `Für: ${cfg.firma}  ·  Teilnehmende: ${cfg.kontakt}  ·  Sektor: ${SEKTOR_NAME[cfg.sektor] || '-'}  ·  Datum: ${cfg.datum || '-'}`;
    neu.xml = setText(neu.xml, zeile);
    parts.kids.splice(pIdx[1] + 1, 0, neu);
  }
  zip.file('word/document.xml', joinBody(parts));
  await fixName(zip);
  return finish(zip);
}

// ── 3 Erfassungsbogen (Teil A vorausgefüllt) ────────────────
async function erfassung(cfg) {
  const zip = await loadTemplate('erfassung');
  const xml = await zip.file('word/document.xml').async('string');
  const parts = splitBody(xml);
  const ps = parts.kids.filter(isP);
  const after = (labelStart, value) => {
    if (!value) return;
    const i = ps.findIndex(k => ptext(k.xml).startsWith(labelStart));
    if (i >= 0 && ps[i + 1]) ps[i + 1].xml = setText(ps[i + 1].xml, value);
  };
  after('Unternehmen / Person', cfg.firma ? `${cfg.firma} (Ansprechperson: ${cfg.kontakt})` : '');
  after('Branche', cfg.branche || SEKTOR_NAME[cfg.sektor] || '');
  after('Zielgruppen', cfg.zielgruppen);
  zip.file('word/document.xml', joinBody(parts));
  await fixName(zip);
  return finish(zip);
}

// ── 0 Briefing (neu per docx) ───────────────────────────────
async function briefing(cfg) {
  const b = cfg.briefing || {};
  const font = 'Calibri';
  const kids = [];
  const run = (text, o = {}) => new TextRun({ text: String(text), font, size: 22, ...o });
  kids.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'RhetorIQ', font })] }));
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `Workshop-Briefing: ${cfg.firma}`, font })] }));
  kids.push(new Paragraph({ children: [run(`${cfg.kontakt}  ·  ${SEKTOR_NAME[cfg.sektor] || '-'}  ·  ${cfg.datum || '-'}`)] }));
  kids.push(new Paragraph({ children: [run('Vorbereitet von der KI aus der Webseite und den bisher erhaltenen Unterlagen. Alle Angaben sind Hypothesen. Bitte vor dem Workshop prüfen.', { italics: true })] }));
  const block = (titel, items, ref) => {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: titel, font })] }));
    for (const it of items || []) {
      kids.push(new Paragraph({
        children: [run(it)],
        ...(ref === 'num' ? { numbering: { reference: 'nummern', level: 0 } } : { bullet: { level: 0 } })
      }));
    }
  };
  const list = v => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
  block('1. Auf einen Blick', list(b.blick));
  block('2. Wie das Unternehmen heute kommuniziert', list(b.kommunikation));
  block('3. Hypothesen zur Stimme (im Workshop prüfen)', list(b.hypothesen));
  block('4. Für die Eröffnung: ein Beispiel aus der Branche', list(b.eroeffnung));
  block('5. Texte des Klienten für Übung 4 (die eigene Sprache hören)', list(b.texte));
  block('6. Fragen, die du stellen solltest', list(b.fragen), 'num');
  block('7. Empfohlene Module und Begründung', (Array.isArray(b.module) ? b.module : []).map(m => (Array.isArray(m) ? `${m[0]}: ${m[1] || ''}` : String(m))));
  block('8. Mögliche Widerstände und wie du reagierst', list(b.widerstaende));
  block('9. Material und Ablauf', list(b.material));
  const doc = new Document({
    styles: { default: { document: { run: { font, size: 22 } } } },
    numbering: { config: [{ reference: 'nummern', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
    sections: [{ children: kids }]
  });
  return Packer.toBuffer(doc);
}

// Liefert [{name, mime, buffer}] für die vier Dokumente.
async function buildWorkshopDocs(cfg) {
  const s = slug(cfg.firma);
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const [b0, b1, b2, b3] = await Promise.all([briefing(cfg), intro(cfg), leitfaden(cfg), erfassung(cfg)]);
  return [
    { name: `0_Briefing_${s}.docx`, mime, buffer: b0 },
    { name: `1_Einfuehrungsgespraech_${s}.docx`, mime, buffer: b1 },
    { name: `2_Workshop_Leitfaden_${s}.docx`, mime, buffer: b2 },
    { name: `3_Erfassungsbogen_${s}.docx`, mime, buffer: b3 }
  ];
}

module.exports = { buildWorkshopDocs, slug, ptext, splitBody, setText };
