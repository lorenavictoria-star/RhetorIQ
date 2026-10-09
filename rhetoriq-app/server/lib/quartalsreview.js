// Quartalsreview: Business enthält ein Gespräch mit Lorena pro Quartal (eine Stunde). Andere Pakete können es für CHF 290 buchen.
// Ohne KI: Die Gesprächsvorlage entsteht aus den vorhandenen Daten.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx');
const cp = require('./commProfile');
const rt = require('./reviewTime');
const { summarize } = require('./stimmReport');

const BUSINESS_TOKENS = 2000000;
const STATUS = ['geplant', 'versendet', 'erledigt'];

function quartalOf(d = new Date()) {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-Q${Math.floor(dt.getUTCMonth() / 3) + 1}`;
}
function validQuartal(q) { return /^\d{4}-Q[1-4]$/.test(String(q || '')); }
function isBusiness(c) {
  return Number(c.monthly_token_limit) === BUSINESS_TOKENS || (!c.monthly_token_limit && c.recommended_plan === 'business');
}

// Pro Klient mit Paket Business: ist der Review dieses Quartals noch offen?
async function dueList(advisorId, now = new Date()) {
  await ensureSchema();
  const quartal = quartalOf(now);
  const { rows: cl } = await pool.query(
    `SELECT id, name, monthly_token_limit, recommended_plan FROM clients WHERE (advisor_id=$1 OR advisor_id IS NULL) AND geloescht_am IS NULL ORDER BY name`, [advisorId]);
  const { rows: qr } = await pool.query(`SELECT client_id, status, termin, notizen, erledigt_am FROM quartalsreviews WHERE quartal=$1`, [quartal]);
  const byClient = new Map(qr.map(r => [Number(r.client_id), r]));
  return {
    quartal,
    clients: cl.filter(isBusiness).map(c => {
      const r = byClient.get(Number(c.id));
      const status = r ? r.status : 'offen';
      return { clientId: c.id, name: c.name, quartal, status, open: status !== 'erledigt', termin: r ? r.termin : null, notizen: r ? r.notizen : null, erledigtAm: r ? r.erledigt_am : null };
    })
  };
}

async function getOne(clientId, quartal) {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT * FROM quartalsreviews WHERE client_id=$1 AND quartal=$2`, [clientId, quartal]);
  return rows[0] || null;
}

async function save(clientId, quartal, { termin, notizen, status }) {
  await ensureSchema();
  if (!validQuartal(quartal)) throw new Error('Ungültiges Quartal. Erwartet wird zum Beispiel 2026-Q4.');
  if (status !== undefined && !STATUS.includes(status)) throw new Error('Status muss geplant, versendet oder erledigt sein.');
  const cur = await getOne(clientId, quartal);
  const next = {
    termin: termin !== undefined ? String(termin || '').slice(0, 200) : (cur ? cur.termin : ''),
    notizen: notizen !== undefined ? String(notizen || '').slice(0, 20000) : (cur ? cur.notizen : ''),
    status: status !== undefined ? status : (cur ? cur.status : 'geplant')
  };
  const erledigtAm = next.status === 'erledigt' ? (cur && cur.erledigt_am ? cur.erledigt_am : new Date().toISOString()) : null;
  if (cur) {
    await pool.query(`UPDATE quartalsreviews SET termin=$3, notizen=$4, status=$5, erledigt_am=$6, updated_at=NOW() WHERE client_id=$1 AND quartal=$2`,
      [clientId, quartal, next.termin, next.notizen, next.status, erledigtAm]);
  } else {
    await pool.query(`INSERT INTO quartalsreviews (client_id, quartal, termin, notizen, status, erledigt_am) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, quartal, next.termin, next.notizen, next.status, erledigtAm]);
  }
  return getOne(clientId, quartal);
}

// Zeilen für die Wochenmail: «Quartalsreview offen: Klient X»
async function weeklyLines(now = new Date()) {
  await ensureSchema();
  const quartal = quartalOf(now);
  const { rows: cl } = await pool.query(`SELECT id, name, monthly_token_limit, recommended_plan FROM clients WHERE geloescht_am IS NULL ORDER BY name`);
  const { rows: done } = await pool.query(`SELECT client_id FROM quartalsreviews WHERE quartal=$1 AND status='erledigt'`, [quartal]);
  const ok = new Set(done.map(r => Number(r.client_id)));
  return cl.filter(c => isBusiness(c) && !ok.has(Number(c.id))).map(c => `Quartalsreview offen: ${c.name} (${quartal})`);
}

// ── Word-Vorlage ──
const FONT = 'Arial';
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 120 : o.after }, children: [new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, color: o.color })] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 140 }, children: [new TextRun({ text: t, font: FONT, size: 28, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 80 }, indent: { left: 360, hanging: 240 }, children: [new TextRun({ text: '•  ' + t, font: FONT, size: 22 })] });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, w, head) {
  return new TableCell({ width: { size: w, type: WidthType.DXA }, borders, shading: head ? { fill: 'E8E1CF', type: ShadingType.CLEAR } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: String(text), font: FONT, size: 20, bold: !!head })] })] });
}

const QUESTIONS = [
  'Welche Texte oder Anlässe waren in diesem Quartal am wichtigsten?',
  'Wo klingen die Texte noch nicht so, wie Sie klingen möchten?',
  'Welche Anlässe stehen im nächsten Quartal an (Reden, Kampagnen, Mitteilungen)?',
  'Wer im Team nutzt die Plattform, und wo braucht es mehr Unterstützung?',
  'Passt das Kontingent, oder braucht es mehr oder weniger Texte?',
  'Was soll sich bis zum nächsten Gespräch verändern?'
];

async function buildVorlage(clientId, quartal = quartalOf()) {
  await ensureSchema();
  const { rows: cr } = await pool.query('SELECT name, monthly_token_limit FROM clients WHERE id=$1', [clientId]);
  if (!cr[0]) throw new Error('Klient nicht gefunden.');
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Quartalsreview, Gesprächsvorlage', font: FONT, size: 48, bold: true })] }));
  kids.push(p(`${cr[0].name}, ${quartal.replace('-', ' ')}`, { size: 28, after: 60 }));
  const rev = await getOne(clientId, quartal);
  kids.push(p(`Termin: ${rev && rev.termin ? rev.termin : 'noch offen'} · Dauer: eine Stunde · Erstellt am ${new Date().toLocaleDateString('de-CH')}`, { size: 20, color: '777777', after: 200 }));

  // 1. Stilprofil
  kids.push(h1('1. Ihr Stil heute im Vergleich zu Ausgangslage und Ziel'));
  const profile = await cp.getProfile(clientId);
  const cur = summarize(profile);
  if (!cur) kids.push(p('Es liegt noch keine Messung vor. Vorschlag: im Gespräch die Texte des Quartals auswerten.'));
  else {
    const base = profile.baseline && profile.baseline.scores;
    const widths = [2400, 1500, 1500, 1500, 2100];
    kids.push(new Table({
      width: { size: 9000, type: WidthType.DXA }, columnWidths: widths,
      rows: [
        new TableRow({ children: ['Merkmal', 'Ausgangslage', 'Heute', 'Ziel', 'Abstand zum Ziel'].map((t, i) => cell(t, widths[i], true)) }),
        ...cur.rows.map(r => new TableRow({ children: [
          cell(r.label, widths[0]), cell(base ? (base[r.key] ?? '–') : '–', widths[1]), cell(r.now, widths[2]),
          cell(r.tgt == null ? '–' : r.tgt, widths[3]), cell(r.tgt == null ? '–' : (r.now - r.tgt > 0 ? '+' : '') + (r.now - r.tgt), widths[4])
        ] }))
      ]
    }));
    kids.push(p('', { after: 60 }));
    if (cur.match != null) kids.push(p(`Übereinstimmung mit der Ziel-Stimme: ${cur.match} Prozent. Grösster Abstand: ${cur.biggest.label}.`, { bold: true }));
  }

  // 2. Zeit
  kids.push(h1('2. Zeit und Mehraufwand der letzten drei Monate'));
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const s = await rt.clientSummary(clientId, d.toISOString().slice(0, 7));
    kids.push(bullet(`${s.month}: ${s.usedMinutes} von ${s.includedMinutes} Minuten verbraucht, Mehraufwand ${s.billedMinutes} Minuten (CHF ${s.extraChf.toFixed(2)})`));
  }

  // 3. Nutzung
  kids.push(h1('3. Nutzung in Texten (letzte 90 Tage)'));
  const { rows: use } = await pool.query(
    `SELECT module_label, COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at > NOW() - INTERVAL '90 days' GROUP BY module_label ORDER BY n DESC`, [clientId]);
  const total = use.reduce((s, r) => s + r.n, 0);
  kids.push(p(`Anzahl Texte und Auswertungen: ${total}`, { bold: true }));
  if (use.length) use.slice(0, 10).forEach(r => kids.push(bullet(`${r.module_label || 'Ohne Bezeichnung'}: ${r.n}`)));
  else kids.push(p('In den letzten 90 Tagen gab es keine Nutzung.'));

  // 4. Fragen
  kids.push(h1('4. Fragen für das Gespräch'));
  QUESTIONS.forEach((q, i) => kids.push(p(`${i + 1}. ${q}`)));

  // 5. Notizen
  kids.push(h1('5. Notizen'));
  if (rev && rev.notizen) String(rev.notizen).split(/\r?\n/).forEach(l => kids.push(p(l)));
  else for (let i = 0; i < 5; i++) kids.push(p('______________________________________________________________'));
  kids.push(h1('6. Nächste Schritte'));
  for (let i = 0; i < 4; i++) kids.push(p('☐  ______________________________________________________'));

  const doc = new Document({
    creator: 'Lorena Lienhard', title: `Quartalsreview ${cr[0].name} ${quartal}`,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } }, children: kids }]
  });
  return { buffer: await Packer.toBuffer(doc), name: cr[0].name, quartal };
}

module.exports = { docHelpers: { FONT, p, h1, bullet, cell }, quartalOf, validQuartal, isBusiness, dueList, getOne, save, weeklyLines, buildVorlage, QUESTIONS };
