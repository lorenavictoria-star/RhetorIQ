// Prüfpaket je Klient als Word: Brand Voice, Stilmittel, die letzten Texte mit Erstfassung, Überarbeitung, Hinweis und Feedback,
// dazu die Befunde der automatischen Prüfung. Zum Ablegen und für gelegentliche Tests. Ohne KI.
const crypto = require('crypto');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType } = require('docx');
const { pool } = require('../db');
const lint = require('./lint');
const { stilmittelRegeln, erlaubtFuer } = require('./lintErlaubt');

const MAX_TEXTE = 15;
const datum = d => new Date(d).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: String(t == null ? '' : t), ...o })] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 140 }, children: [new TextRun(t)] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 100 }, children: [new TextRun(t)] });
const bd = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: bd, bottom: bd, left: bd, right: bd };
const cell = (t, w, head) => new TableCell({ borders, width: { size: w, type: WidthType.DXA }, shading: head ? { fill: 'EEF2EE', type: ShadingType.CLEAR } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ children: [new TextRun({ text: String(t), bold: !!head, size: 18 })] })] });
function table(rows, widths) {
  return new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, rows: rows.map((r, i) => new TableRow({ children: r.map((c, j) => cell(c, widths[j], i === 0)) })) });
}
const textart = (module, key) => (module && key && String(key).startsWith(module + '-') ? String(key).slice(module.length + 1) : null);

async function laden(clientId) {
  const { rows: cl } = await pool.query('SELECT id, name, industry FROM clients WHERE id=$1', [clientId]);
  const { rows: bv } = await pool.query(`SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY memory_type`, [clientId]);
  const { rows: an } = await pool.query(
    `SELECT id, module, module_label, feedback_key, input_data, result, created_at, ueberarbeitung, ueberarbeitung_hinweis, user_rating, feedback_note
     FROM analyses WHERE client_id=$1 AND result IS NOT NULL ORDER BY created_at DESC LIMIT $2`, [clientId, MAX_TEXTE * 2]);
  return { client: cl[0] || { name: 'Klient' }, bv, an };
}

// Gruppiert nach Eingabe: ältester Text einer Gruppe = Erstfassung, spätere = Überarbeitungen
function fassungen(an) {
  const gruppen = {};
  for (const a of an) {
    const k = a.module + '|' + crypto.createHash('md5').update(JSON.stringify(a.input_data || null)).digest('hex').slice(0, 12);
    (gruppen[k] = gruppen[k] || []).push(a);
  }
  const info = new Map();
  for (const l of Object.values(gruppen)) {
    l.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    l.forEach((a, i) => info.set(a.id, l.length > 1 ? { n: i, von: l.length } : null));
  }
  return info;
}

async function buildPruefpaket(clientId) {
  const { client, bv, an } = await laden(clientId);
  const bvText = bv.map(r => r.content).join('\n\n');
  const regeln = stilmittelRegeln(bvText);
  const info = fassungen(an);
  const texte = an.slice(0, MAX_TEXTE);
  const kids = [];
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Prüfpaket: ' + client.name)] }));
  kids.push(p('Erstellt am ' + datum(new Date()) + '. Enthält die Brand Voice, die letzten ' + texte.length + ' Texte mit Fassung, Hinweis und Feedback und die Befunde der automatischen Prüfung. Zum Ablegen oder um es für einen Test weiterzugeben. Enthält Klientendaten: verschlüsselt ablegen.', { color: '5F6B63' }));

  // Überblick der Befunde
  const zeilen = [['Datum', 'Textart', 'Fassung', 'Befunde der Prüfung']];
  const detail = [];
  for (const a of texte) {
    const ta = textart(a.module, a.feedback_key);
    const erlaubt = erlaubtFuer(regeln, ta);
    const hits = lint.lintText(a.result, Object.assign(lint.lintOptionenAusDaten(a.input_data, erlaubt), {}));
    const arten = {};
    hits.filter(h => !h.weich).forEach(h => { const l = lint.ART_LABEL[h.art] || h.art; arten[l] = (arten[l] || 0) + 1; });
    const f = info.get(a.id);
    const fassung = f ? (f.n === 0 ? 'Erstfassung' : 'Überarbeitung ' + f.n) : 'Einzeltext';
    zeilen.push([datum(a.created_at), a.module_label || a.module, fassung, Object.keys(arten).length ? Object.entries(arten).map(([k, v]) => k + ' ' + v).join(', ') : 'keine']);
    detail.push({ a, fassung, hits, f });
  }
  kids.push(h1('Überblick'));
  kids.push(table(zeilen, [1900, 2100, 1700, 3400]));

  kids.push(h1('Brand Voice'));
  kids.push(p('Stilmittel erlaubt (aus der Brand Voice): ' + (regeln.length ? regeln.map(r => r.art + (r.textarten ? ' (' + [...r.textarten].join(', ') + ')' : '')).join('; ') : 'keine Zeile vorhanden, strenge Linie') + '.'));
  kids.push(p('Länge: ' + bvText.length + ' Zeichen.', { color: '5F6B63' }));
  for (const r of bv) {
    kids.push(h2(r.memory_type));
    for (const z of String(r.content || '').split('\n')) kids.push(p(z));
  }

  kids.push(h1('Texte'));
  for (const d of detail) {
    const { a } = d;
    kids.push(h2(datum(a.created_at) + ' · ' + (a.module_label || a.module) + ' · ' + d.fassung));
    if (d.f && d.f.n > 0) kids.push(p('Hinweis für die Überarbeitung: ' + (a.ueberarbeitung_hinweis || 'nicht gespeichert (Text vor dem 22.10.2026)'), { bold: true }));
    if (a.user_rating) kids.push(p('Bewertung: ' + (a.user_rating === 1 ? 'Daumen hoch' : 'Daumen runter') + (a.feedback_note ? ', Feedback: ' + a.feedback_note : '')));
    else if (a.feedback_note) kids.push(p('Feedback: ' + a.feedback_note));
    const hartTreffer = d.hits.filter(h => !h.weich);
    if (hartTreffer.length) kids.push(p('Prüfung: ' + hartTreffer.slice(0, 12).map(h => (lint.ART_LABEL[h.art] || h.art) + ' «' + h.kontext + '»').join(' | '), { color: 'A32D2D', size: 19 }));
    for (const z of String(a.result || '').split('\n')) kids.push(p(z));
  }
  const doc = new Document({ styles: { default: { document: { run: { font: 'Arial', size: 21 } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 } } }, children: kids }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildPruefpaket, fassungen };
