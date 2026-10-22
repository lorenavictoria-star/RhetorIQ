// Prüfpaket je Klient als Word: Brand Voice, Stilmittel, die letzten Texte mit Erstfassung, Überarbeitung, Hinweis und Feedback,
// dazu die Befunde der automatischen Prüfung. Zum Ablegen und für gelegentliche Tests. Ohne KI.
const crypto = require('crypto');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType } = require('docx');
const { pool } = require('../db');
const lint = require('./lint');
const { stilmittelRegeln, erlaubtFuer } = require('./lintErlaubt');

const MAX_AUFTRAEGE = 8;   // Aufträge aus möglichst verschiedenen Textarten und Modulen
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
  const { rows: cl } = await pool.query('SELECT id, name, industry, regulierung FROM clients WHERE id=$1', [clientId]);
  const { rows: bv } = await pool.query(`SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY memory_type`, [clientId]);
  const { rows: an } = await pool.query(
    `SELECT id, module, module_label, feedback_key, input_data, result, created_at, ueberarbeitung, ueberarbeitung_hinweis, user_rating, feedback_note
     FROM analyses WHERE client_id=$1 AND result IS NOT NULL ORDER BY created_at DESC LIMIT $2`, [clientId, 120]);
  return { client: cl[0] || { name: 'Klient' }, bv, an };
}

// Gruppiert nach Eingabe: ältester Text einer Gruppe = Erstfassung, spätere = Überarbeitungen
function gruppen(an) {
  const g = {};
  for (const a of an) {
    const k = a.module + '|' + crypto.createHash('md5').update(JSON.stringify(a.input_data || null)).digest('hex').slice(0, 12);
    (g[k] = g[k] || []).push(a);
  }
  const liste = Object.values(g);
  for (const l of liste) l.sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  return liste.sort((x, y) => new Date(y[y.length - 1].created_at) - new Date(x[x.length - 1].created_at));
}

// Wählt bis zu MAX_AUFTRAEGE Aufträge, zuerst je Textart oder Modul der neueste, dann die nächsten
function auswahl(an, max = MAX_AUFTRAEGE) {
  const alle = gruppen(an);
  const gesehen = new Set();
  const erste = [], rest = [];
  for (const l of alle) {
    const last = l[l.length - 1];
    const art = last.module + '|' + (textart(last.module, last.feedback_key) || '');
    if (!gesehen.has(art) && erste.length < max) { gesehen.add(art); erste.push(l); } else rest.push(l);
  }
  const gewaehlt = erste.concat(rest.slice(0, Math.max(0, max - erste.length)));
  return gewaehlt.sort((x, y) => new Date(y[y.length - 1].created_at) - new Date(x[x.length - 1].created_at));
}

// Fassung je Text: {n, von} oder null bei Einzeltext
function fassungen(an) {
  const info = new Map();
  for (const l of gruppen(an)) l.forEach((a, i) => info.set(a.id, l.length > 1 ? { n: i, von: l.length } : null));
  return info;
}

async function buildPruefpaket(clientId) {
  const { client, bv, an } = await laden(clientId);
  const bvText = bv.map(r => r.content).join('\n\n');
  const regeln = stilmittelRegeln(bvText);
  const info = fassungen(an);
  const aus = auswahl(an);
  // je Auftrag die Erstfassung und die letzte Überarbeitung (mittlere Fassungen werden nur gezählt)
  const texte = [];
  const uebersprungen = new Map();
  for (const l of aus) {
    texte.push(l[0]);
    if (l.length > 1) { texte.push(l[l.length - 1]); if (l.length > 2) uebersprungen.set(l[l.length - 1].id, l.length - 2); }
  }
  const kids = [];
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Prüfpaket: ' + client.name)] }));
  kids.push(p('Erstellt am ' + datum(new Date()) + '. Enthält die Brand Voice und ' + aus.length + ' Aufträge aus möglichst verschiedenen Textarten und Modulen, je mit Erstfassung und letzter Überarbeitung, Hinweis, Feedback und den Befunden der automatischen Prüfung. Zum Ablegen oder um es für einen Test weiterzugeben. Enthält Klientendaten: verschlüsselt ablegen.', { color: '5F6B63' }));

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
  const REG = { keine: 'keine besondere', bank_versicherung: 'Bank oder Versicherung (FINMA)', boersenkotiert: 'börsenkotiert', andere: 'andere' };
  if (client.regulierung) kids.push(p('Regulierung der Kundschaft: ' + (REG[client.regulierung] || client.regulierung) + '.', { color: '5F6B63' }));
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
    if (uebersprungen.has(a.id)) kids.push(p('Dazwischen gab es ' + uebersprungen.get(a.id) + ' weitere Fassung(en), hier nicht aufgeführt.', { color: '5F6B63' }));
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

module.exports = { buildPruefpaket, fassungen, auswahl };
