// Stimmenmappe und Handbuch je Klient als Word, dazu ZIP über alle Klienten der Beraterin.
// Ohne KI: Alles wird regelbasiert aus der Datenbank zusammengestellt, damit die Beraterin auch bei einem
// Ausfall der Plattform oder der KI in der Stimme jedes Klienten schreiben kann (Ausfallbericht, Rückfall ohne KI).
const { pool } = require('../db');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, PageBreak
} = require('docx');
const JSZip = require('jszip');
const cp = require('./commProfile');
const { listSentences } = require('./learnedMeta');
const { baseFor, NAMES } = require('./userLimit');

const FONT = 'Arial';
const DATE = d => new Date(d).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
const clean = s => String(s == null ? '' : s).replace(/\r/g, '');

// ── Bausteine ───────────────────────────────────────────────────────────────
const run = (text, o = {}) => new TextRun({ text: String(text), font: FONT, size: o.size || 22, bold: o.bold, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 120 : o.after }, children: [run(text, o)] });
// Mehrzeiliger Text: jede Zeile ein Absatz, damit Umbrüche im Word erhalten bleiben
const block = (text, o = {}) => clean(text).split('\n').map(l => p(l, { ...o, after: l.trim() ? 60 : 20 }));
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 }, children: [run(t, { size: 30, bold: true })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }, children: [run(t, { size: 24, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 70 }, indent: { left: 360, hanging: 240 }, children: [run('•  ' + t)] });
const numbered = (n, t) => new Paragraph({ spacing: { after: 80 }, indent: { left: 400, hanging: 400 }, children: [run(n + '.  ' + t)] });
const hint = t => p(t, { size: 19, color: '777777' });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, w, head) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: head ? { fill: 'E8E1CF', type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: clean(text).split('\n').map(l => new Paragraph({ children: [run(l, { size: 20, bold: !!head })] }))
  });
}
function table(widths, head, rows) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ children: head.map((t, i) => cell(t, widths[i], true)) }),
      ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, widths[i])) }))]
  });
}

// ── Daten ───────────────────────────────────────────────────────────────────
const q = (sql, params) => pool.query(sql, params).then(r => r.rows).catch(() => []);

async function collect(clientId) {
  const [client] = await q('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!client) return null;
  const memory = await q('SELECT memory_type, content, updated_at FROM company_memory WHERE client_id=$1 ORDER BY memory_type', [clientId]);
  const people = await q('SELECT id, name, role, department, notes FROM people WHERE client_id=$1 ORDER BY name', [clientId]);
  const profiles = await q(
    `SELECT pp.person_id, pp.profile_type, pp.content, pp.updated_at FROM people_profiles pp
     JOIN people pe ON pe.id = pp.person_id WHERE pe.client_id=$1 ORDER BY pp.profile_type`, [clientId]);
  const prompts = await q('SELECT module_key, instructions, updated_at FROM client_module_prompts WHERE client_id=$1 ORDER BY module_key', [clientId]);
  const learnings = await q('SELECT * FROM client_feedback_learnings WHERE client_id=$1 ORDER BY module_key, category', [clientId]);
  const samples = await q(
    `SELECT module_label, edited_text, updated_at FROM review_requests
     WHERE client_id=$1 AND status='approved' AND LENGTH(COALESCE(edited_text,'')) > 80 ORDER BY updated_at DESC LIMIT 5`, [clientId]);
  const recent = await q(
    `SELECT edited_text FROM review_requests WHERE client_id=$1 AND status='approved' AND LENGTH(COALESCE(edited_text,'')) > 80 ORDER BY updated_at DESC LIMIT 20`, [clientId]);
  let profile = null;
  try { profile = await cp.getProfile(clientId); } catch { profile = null; }
  return { client, memory, people, profiles, prompts, learnings, samples, recentTexts: recent.map(r => r.edited_text), profile };
}

const isBrandVoice = m => /^brand_voice/.test(m.memory_type);
const isReference = m => /^ref_tg_/.test(m.memory_type) || m.memory_type === 'structural_reference' || m.memory_type === 'key_facts';

const REF_LABEL = {
  ref_tg_email: 'E-Mail', ref_tg_linkedin: 'LinkedIn', ref_tg_newsletter: 'Newsletter', ref_tg_speech: 'Rede',
  ref_tg_press: 'Pressemitteilung', ref_tg_website: 'Webseite', structural_reference: 'Aufbau (Strukturvorlage)', key_facts: 'Eckdaten und Fakten'
};
const refLabel = t => REF_LABEL[t] || t.replace(/^ref_tg_/, '').replace(/_/g, ' ');

// Do's und Don'ts aus dem Text der Brand Voice (Überschrift mit Do oder Don't, darunter Aufzählungen)
function doDont(brandVoice) {
  const dos = [], donts = [];
  let mode = null;
  for (const raw of clean(brandVoice).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.replace(/^[#>*\s_-]+/, '').replace(/[*_:]+$/g, '').trim();
    const isBullet = /^([-*•]|\d+[.)])\s+/.test(line);
    if (!isBullet && head.length < 70) {
      if (/^(do'?s?|dos|das tun wir|immer)\b/i.test(head)) { mode = 'do'; continue; }
      if (/^(don'?ts?|dont|vermeiden|nie\b|das tun wir nicht|wörter, die|worte, die)/i.test(head)) { mode = 'dont'; continue; }
      if (/^#{1,6}\s/.test(line) || /^\*\*.+\*\*:?$/.test(line)) { mode = null; continue; }
    }
    if (isBullet && mode) {
      const t = line.replace(/^([-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim();
      if (t) (mode === 'do' ? dos : donts).push(t);
    }
  }
  return { dos, donts };
}

// Alle gelernten Sätze mit Herkunft, wichtigste zuerst (Zähler, dann Datum)
function learnedSentences(learnings) {
  const out = [];
  for (const row of learnings) {
    for (const s of listSentences(row)) out.push({ text: s.text, at: s.at, count: s.count, module: row.module_key, category: row.category });
  }
  return out.sort((a, b) => (b.count - a.count) || (new Date(b.at) - new Date(a.at)));
}

const BASIS_REGELN = [
  'Schweizer Rechtschreibung: ss statt ß.',
  'Keine Gedankenstriche, stattdessen Punkt oder Komma.',
  'Die Kernaussage steht im ersten Satz.',
  'Jede Aussage nur einmal sagen, keine Floskeln.',
  'Zahlen und Namen nur mit Beleg.',
  'Anrede und Grussformel gleich wie in den Mustertexten.'
];

// Zehn Regeln, regelbasiert: oberste gelernte Sätze, dann Do's und Don'ts der Brand Voice, dann Grundregeln
function tenRules(data) {
  const bv = data.memory.filter(isBrandVoice).map(m => m.content).join('\n');
  const { dos, donts } = doDont(bv);
  const learned = learnedSentences(data.learnings).map(x => x.text);
  const rules = [];
  const add = (t, from) => { const k = t.toLowerCase(); if (rules.length < 10 && !rules.some(r => r.text.toLowerCase() === k)) rules.push({ text: t, from }); };
  learned.slice(0, 4).forEach(t => add(t, 'gelernte Vorliebe'));
  const m = Math.max(dos.length, donts.length);
  for (let i = 0; i < m; i++) {
    if (dos[i]) add(dos[i], 'Do aus der Brand Voice');
    if (donts[i]) add('Vermeiden: ' + donts[i], 'Don\'t aus der Brand Voice');
  }
  learned.slice(4).forEach(t => add(t, 'gelernte Vorliebe'));
  BASIS_REGELN.forEach(t => add(t, 'Grundregel der Plattform'));
  return rules;
}

function paket(client) {
  try {
    const { plan } = baseFor(client);
    return plan ? NAMES[plan] : 'noch kein Paket gewählt';
  } catch { return 'unbekannt'; }
}

function metricsOf(data) {
  const pr = data.profile;
  const m = pr && ((pr.latest && pr.latest.metrics) || (pr.baseline && pr.baseline.metrics));
  if (m && m.avgSentenceLength != null) return { ...m, quelle: 'Stimmprofil' };
  if (data.recentTexts.length) return { ...cp.computeMetrics(data.recentTexts), quelle: 'die letzten ' + data.recentTexts.length + ' gesendeten Texte' };
  return null;
}

// ── Stimmenmappe ────────────────────────────────────────────────────────────
async function buildMappe(clientId) {
  const d = await collect(clientId);
  if (!d) throw new Error('Klient nicht gefunden.');
  const c = d.client;
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 60 }, children: [run('Stimmenmappe', { size: 52, bold: true })] }));
  kids.push(p(c.name, { size: 30, after: 60 }));
  kids.push(p(`Stand ${DATE(new Date())} · gesammelt aus RhetorIQ, lesbar ohne Plattform und ohne KI`, { size: 20, color: '777777', after: 200 }));

  // 1 Steckbrief
  kids.push(h1('1. Steckbrief'));
  kids.push(table([2600, 6400], ['Angabe', 'Inhalt'], [
    ['Firma', c.name],
    ['Branche', c.industry || 'nicht erfasst'],
    ['Ansprechperson', [c.contact, [c.salutation, c.last_name].filter(Boolean).join(' ')].filter(Boolean)[0] || 'nicht erfasst'],
    ['E-Mail', c.email || 'nicht erfasst'],
    ['Art', c.client_type || 'nicht erfasst'],
    ['Paket', paket(c)]
  ]));

  // 2 Brand Voice
  kids.push(h1('2. Brand Voice vollständig'));
  const bvs = d.memory.filter(isBrandVoice);
  if (!bvs.length) kids.push(p('Für diesen Klienten ist noch keine Brand Voice hinterlegt.'));
  for (const m of bvs) {
    kids.push(h2(`${m.memory_type === 'brand_voice' ? 'Brand Voice' : m.memory_type} (Stand ${DATE(m.updated_at)})`));
    kids.push(...block(m.content));
  }

  // 3 Zehn Regeln
  kids.push(h1('3. Die zehn Regeln'));
  kids.push(hint('Zusammengestellt aus den obersten gelernten Vorlieben und den Do\'s und Don\'ts der Brand Voice. Ergänze und streiche von Hand, was sich nicht mehr stimmig anfühlt.'));
  tenRules(d).forEach((r, i) => kids.push(numbered(i + 1, `${r.text} (${r.from})`)));

  // 4 Referenztexte
  kids.push(h1('4. Referenztexte'));
  const refs = d.memory.filter(isReference);
  if (!refs.length) kids.push(p('Keine Referenztexte hinterlegt.'));
  for (const m of refs) { kids.push(h2(`${refLabel(m.memory_type)} (Stand ${DATE(m.updated_at)})`)); kids.push(...block(m.content)); }

  // 5 Personenprofile
  kids.push(h1('5. Personenprofile'));
  if (!d.people.length) kids.push(p('Keine Personen erfasst.'));
  for (const pe of d.people) {
    kids.push(h2([pe.name, pe.role, pe.department].filter(Boolean).join(', ')));
    if (pe.notes) kids.push(...block(pe.notes));
    const pr = d.profiles.filter(x => x.person_id === pe.id);
    if (!pr.length) kids.push(hint('Noch kein Profil.'));
    for (const x of pr) { kids.push(p(`${x.profile_type} (Stand ${DATE(x.updated_at)})`, { bold: true, after: 40 })); kids.push(...block(x.content)); }
  }

  // 6 Modul-Anweisungen
  kids.push(h1('6. Anweisungen je Textart'));
  if (!d.prompts.length) kids.push(p('Keine eigenen Anweisungen hinterlegt.'));
  for (const x of d.prompts) { kids.push(h2(`${x.module_key} (Stand ${DATE(x.updated_at)})`)); kids.push(...block(x.instructions)); }

  // 7 Gelernte Vorlieben
  kids.push(h1('7. Gelernte Vorlieben'));
  const ls = learnedSentences(d.learnings);
  if (!ls.length) kids.push(p('Noch nichts gelernt.'));
  else kids.push(table([4700, 1300, 1900, 1100], ['Vorliebe', 'Datum', 'Herkunft', 'Anzahl'], ls.map(s => [s.text, DATE(s.at), `${s.module}, ${s.category}`, String(s.count)])));

  // 8 Mustertexte
  kids.push(h1('8. Mustertexte'));
  kids.push(hint('Die jüngsten Texte, die du nach deiner Bearbeitung gesendet hast.'));
  if (!d.samples.length) kids.push(p('Noch keine gesendeten Freigaben.'));
  d.samples.forEach((s, i) => { kids.push(h2(`Muster ${i + 1}: ${s.module_label || 'Text'} (${DATE(s.updated_at)})`)); kids.push(...block(s.edited_text)); });

  // 9 Stimmprofil
  kids.push(h1('9. Stimmprofil mit Zielwerten'));
  const pr = d.profile, now = pr && ((pr.latest && pr.latest.scores) || (pr.baseline && pr.baseline.scores)), tgt = pr && pr.target && pr.target.scores;
  if (!now) kids.push(p('Noch kein Stimmprofil gemessen.'));
  else {
    kids.push(table([3400, 1800, 1800], ['Merkmal', 'Heute', 'Ziel'], pr.dims.map(x => [x.label, String(now[x.key] != null ? now[x.key] : ''), tgt && tgt[x.key] != null ? String(tgt[x.key]) : 'kein Ziel'])));
    const m = metricsOf(d);
    if (m) kids.push(p(`Durchschnittliche Satzlänge ${m.avgSentenceLength} Wörter, ${m.longSentenceShare} Prozent der Sätze haben mehr als 25 Wörter.`));
  }

  return Packer.toBuffer(new Document({ creator: 'RhetorIQ', title: 'Stimmenmappe ' + c.name, sections: [{ children: kids }] }));
}

// ── Handbuch (eine Seite) ───────────────────────────────────────────────────
function tonLine(bv) {
  const m = clean(bv).match(/^\s*[#*\s_-]*(ton|tonalität|tonalitaet|stimmung)[*_:\s-]+(.{3,160})$/im);
  return m ? m[2].replace(/\*\*/g, '').trim() : null;
}
function anrede(bv, c, m) {
  const t = clean(bv);
  if (/\b(duzen|per du|du-form|du form)\b/i.test(t)) return 'Du-Form (laut Brand Voice).';
  if (/\b(siezen|sie-form|sie form|per sie)\b/i.test(t)) return 'Sie-Form (laut Brand Voice).';
  if (m && m.sentenceCount) return 'In den Texten kommen Anredeformen in ' + m.directAddressTexts + ' Texten vor. Prüfe an den Mustertexten, ob Du oder Sie gilt.';
  return 'Noch offen, bitte an den Mustertexten prüfen.';
}

async function buildHandbuch(clientId) {
  const d = await collect(clientId);
  if (!d) throw new Error('Klient nicht gefunden.');
  const c = d.client;
  const bv = d.memory.filter(isBrandVoice).map(m => m.content).join('\n');
  const { donts } = doDont(bv);
  const m = metricsOf(d);
  const kids = [];
  kids.push(p(`Handbuch: Texte von Hand für ${c.name}`, { size: 34, bold: true, after: 40 }));
  kids.push(hint(`Stand ${DATE(new Date())}. Eine Seite, brauchbar ohne Plattform.`));

  kids.push(h2('Ton'));
  kids.push(p(tonLine(bv) || 'In der Brand Voice nicht ausdrücklich benannt. Lies die ersten Absätze der Stimmenmappe.'));
  kids.push(h2('Anrede und Grussformel'));
  kids.push(p(anrede(bv, c, m)));
  kids.push(h2('Satzbau'));
  kids.push(p(m ? `Durchschnittlich ${m.avgSentenceLength} Wörter pro Satz. ${m.longSentenceShare} Prozent der Sätze sind länger als 25 Wörter (Grundlage: ${m.quelle}). Kurze und lange Sätze wechseln, ein Gedanke pro Absatz.` : 'Noch keine Zahlen vorhanden. Orientiere dich an den Mustertexten.'));
  kids.push(h2('Lieblingswörter und Wendungen'));
  kids.push(p(m && m.topPhrases && m.topPhrases.length ? m.topPhrases.map(x => `${x.phrase} (${x.count})`).join(', ') : 'Noch keine häufigen Wendungen erkannt.'));
  kids.push(h2('Aufbau je Textart'));
  kids.push(bullet('E-Mail: Anliegen im ersten Satz, dann Begründung, dann nächster Schritt mit Frist.'));
  kids.push(bullet('LinkedIn: Haken in der ersten Zeile, ein Gedanke, kurze Absätze.'));
  kids.push(bullet('Newsletter: Betreff, Einstieg, ein Thema, Handlungsaufforderung.'));
  kids.push(bullet('Rede: zum Hören geschrieben, Wiederholungen sind erlaubt.'));
  kids.push(h2('Das schreibt dieser Klient nie'));
  kids.push(p(donts.length ? donts.slice(0, 6).join('; ') + '.' : 'Zusagen, Zahlen ohne Beleg und Wertungen über Dritte.'));
  kids.push(h2('Prüfliste vor dem Senden'));
  ['Passt die Anrede?', 'Steht die Kernaussage vorn?', 'Ist jede Zahl belegt?', 'Klingt der erste Satz wie der Klient?', 'Schweizer Rechtschreibung, keine Gedankenstriche?', 'Wer prüft gegen (Vier-Augen-Prinzip), wenn möglich?']
    .forEach(t => kids.push(bullet(t)));
  return Packer.toBuffer(new Document({ creator: 'RhetorIQ', title: 'Handbuch ' + c.name, sections: [{ children: kids }] }));
}

// ── ZIP über alle Klienten der Beraterin ────────────────────────────────────
const safeName = s => String(s || 'Klient').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Klient';

async function buildZip(advisorId) {
  const { rows } = await pool.query('SELECT id, name FROM clients WHERE (advisor_id=$1 OR advisor_id IS NULL) AND geloescht_am IS NULL ORDER BY name', [advisorId]);
  const zip = new JSZip();
  const used = new Set();
  for (const r of rows) {
    let base = safeName(r.name);
    if (used.has(base)) base += '_' + r.id;
    used.add(base);
    zip.file(`${base}/Stimmenmappe_${base}.docx`, await buildMappe(r.id));
    zip.file(`${base}/Handbuch_${base}.docx`, await buildHandbuch(r.id));
  }
  if (!rows.length) zip.file('LIES_MICH.txt', 'Es sind keine Klienten vorhanden.');
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), count: rows.length };
}

module.exports = { buildMappe, buildHandbuch, buildZip, collect, tenRules, doDont, learnedSentences, safeName };
