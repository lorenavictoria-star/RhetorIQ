// Automatische Quartalsauswertung als Word.
// Wer bekommt sie: Klienten mit Paket Business oder Enterprise (Gespräch im Paket) und Klienten mit dem Zusatz «Quartalsreview»
// (CHF 290 pro Quartal, Flag clients.quartalsreview_aktiv, gesetzt vom Zahlungs-Webhook).
// Wann: am 2. Tag nach Quartalsende um 07:00 Zürcher Zeit (jobs/quartalsauswertung.js).
// Inhalt: nur vorhandene Daten (Nutzung, Lernstand, Highlights). Die KI formuliert Zusammenfassung und Empfehlungen aus Kennzahlen,
// ohne Textinhalte, Klientennamen oder Regelwortlaut. Das Word entsteht bei jedem Abruf neu aus den gespeicherten Kennzahlen.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const aiProvider = require('./aiProvider');
const meter = require('./meter');
const qr = require('./quartalsreview');
const userLimit = require('./userLimit');
const { datumZuerich } = require('./heute');
const learnedMeta = require('./learnedMeta');
const lernkurve = require('./lernkurve');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, WidthType } = require('docx');

const CAP_USD = parseFloat(process.env.QUARTALSREVIEW_CAP_USD) || 0.20;   // Obergrenze je Klient und Lauf
const TOKENS_PRO_TEXT = 5000;      // wie das Monatskontingent der Pakete gerechnet ist (routes/subscriptions.js)
const GEFESTIGT_AB = 3;            // eine gelernte Regel gilt ab so vielen Bestätigungen als gefestigt
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function schweiz(t) {
  return String(t || '').replace(/\s[–—]\s/g, ', ').replace(/[–—]/g, '-').replace(/ß/g, 'ss');
}
function clean(t, max) {
  return schweiz(String(t || '').replace(/[​-‍‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max));
}

// ── Quartal ──
// Das Quartal, das vor dem Datum zu Ende gegangen ist (am 2. Januar: das vierte Quartal des Vorjahres)
function vorherigesQuartal(now = new Date()) {
  const { y, m } = datumZuerich(now);
  const q = Math.ceil(m / 3);
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}
function quartalRange(quartal) {
  if (!qr.validQuartal(quartal)) throw new Error('Ungültiges Quartal.');
  const y = Number(quartal.slice(0, 4)), q = Number(quartal.slice(6));
  return { von: new Date(Date.UTC(y, (q - 1) * 3, 1)), bis: new Date(Date.UTC(y, q * 3, 1)), jahr: y, q };
}
function davor(quartal) {
  const { jahr, q } = quartalRange(quartal);
  return q === 1 ? `${jahr - 1}-Q4` : `${jahr}-Q${q - 1}`;
}
const quartalLabel = quartal => `Q${quartal.slice(6)} ${quartal.slice(0, 4)}`;

// ── Wer ist berechtigt ──
const AUSGESCHLOSSEN = ['cancelled'];
function planOf(c) { return userLimit.baseFor(c).plan; }

// Liste der Klienten, die für dieses Quartal eine Auswertung bekommen: Paket Business oder Enterprise, oder Zusatz aktiv
async function berechtigte() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, name, monthly_token_limit, recommended_plan, subscription_status, quartalsreview_aktiv FROM clients WHERE geloescht_am IS NULL ORDER BY id`);
  const out = [];
  for (const c of rows) {
    if (AUSGESCHLOSSEN.includes(c.subscription_status)) continue;
    const plan = planOf(c);
    const imPaket = plan === 'business' || plan === 'enterprise';
    if (imPaket) out.push({ id: c.id, name: c.name, plan, grund: 'paket' });
    else if (c.quartalsreview_aktiv === true) out.push({ id: c.id, name: c.name, plan, grund: 'zusatz' });
  }
  return out;
}

// ── Kennzahlen ──
async function safe(sql, params) {
  try { return (await pool.query(sql, params)).rows; } catch { return []; }
}

async function sammle(clientId, quartal) {
  const { von, bis } = quartalRange(quartal);
  const vq = quartalRange(davor(quartal));
  const [c] = await safe('SELECT id, name, monthly_token_limit, recommended_plan FROM clients WHERE id=$1', [clientId]);
  if (!c) throw new Error('Klient nicht gefunden.');
  const plan = planOf(c);
  const limit = c.monthly_token_limit == null ? null : Number(c.monthly_token_limit);

  // Nutzung
  const artRows = await safe('SELECT module_label FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3', [clientId, von, bis]);
  const artZaehler = new Map();
  for (const r of artRows) { const k = r.module_label || 'Ohne Bezeichnung'; artZaehler.set(k, (artZaehler.get(k) || 0) + 1); }
  const proArt = [...artZaehler].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const total = proArt.reduce((s, r) => s + r.n, 0);
  const [vorRow] = await safe('SELECT COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3', [clientId, vq.von, vq.bis]);
  const proMonat = [];
  for (let i = 0; i < 3; i++) {
    const a = new Date(Date.UTC(von.getUTCFullYear(), von.getUTCMonth() + i, 1)), b = new Date(Date.UTC(von.getUTCFullYear(), von.getUTCMonth() + i + 1, 1));
    const [r] = await safe('SELECT COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3', [clientId, a, b]);
    proMonat.push({ monat: MONATE[a.getUTCMonth()], n: r ? r.n : 0 });
  }
  const kontingentMonat = limit == null ? null : Math.floor(limit / TOKENS_PRO_TEXT);
  const kontingentQuartal = kontingentMonat == null ? null : kontingentMonat * 3;
  const nutzung = {
    total, vorquartal: vorRow ? vorRow.n : 0, proArt, proMonat,
    kontingentMonat, kontingentQuartal,
    auslastungProzent: kontingentQuartal ? Math.round(100 * total / kontingentQuartal) : null
  };

  // Lernstand: gelernte Regeln (client_feedback_learnings), «neu» = in diesem Quartal gelernt, «gefestigt» = mehrfach bestätigt
  const lernRows = await safe('SELECT * FROM client_feedback_learnings WHERE client_id=$1', [clientId]);
  const kat = new Map();
  const regeln = [];
  for (const row of lernRows) {
    let sentences = [];
    try { sentences = learnedMeta.listSentences(row); } catch { sentences = []; }
    for (const s of sentences) {
      const at = new Date(s.at);
      const neu = at >= von && at < bis;
      const gef = s.count >= GEFESTIGT_AB;
      const k = kat.get(row.category) || { kategorie: row.category, neu: 0, gefestigt: 0, gesamt: 0 };
      k.gesamt++; if (neu) k.neu++; if (gef) k.gefestigt++;
      kat.set(row.category, k);
      if (neu || gef) regeln.push({ kategorie: row.category, text: s.text, neu, gefestigt: gef, count: s.count });
    }
  }
  const kategorien = [...kat.values()].sort((a, b) => b.gesamt - a.gesamt || String(a.kategorie).localeCompare(String(b.kategorie)));
  const lern = {
    neu: kategorien.reduce((s, k) => s + k.neu, 0),
    gefestigt: kategorien.reduce((s, k) => s + k.gefestigt, 0),
    gesamt: kategorien.reduce((s, k) => s + k.gesamt, 0),
    kategorien, regeln: regeln.slice(0, 20)
  };

  // Highlights: mit Daumen nach oben bewertete Texte (nur Textart und Datum), Freigaben, Entwicklung der Freigabequote
  const stark = await safe(
    `SELECT module_label, created_at FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3 AND user_rating = 1 ORDER BY created_at DESC LIMIT 5`,
    [clientId, von, bis]);
  const [pos] = await safe(`SELECT COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3 AND user_rating = 1`, [clientId, von, bis]);
  const [neg] = await safe(`SELECT COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at >= $2 AND created_at < $3 AND user_rating = -1`, [clientId, von, bis]);
  const frg = await safe(
    `SELECT status, COUNT(*)::int AS n FROM review_requests WHERE client_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY status`, [clientId, von, bis]);
  const freigaben = Object.fromEntries(frg.map(r => [r.status, r.n]));
  let kurve = [];
  try {
    const letzter = new Date(bis.getTime() - 86400000);
    kurve = (await lernkurve.monatlicheKurve(clientId, 3, new Date(letzter.getUTCFullYear(), letzter.getUTCMonth(), 15)))
      .map(m => ({ monat: m.name, freigaben: m.freigaben, prozent: m.prozent, ausreichend: m.ausreichend }));
  } catch { kurve = []; }
  const highlights = {
    positiv: pos ? pos.n : 0, negativ: neg ? neg.n : 0,
    staerkste: stark.map(r => ({ textart: r.module_label || 'Ohne Bezeichnung', datum: new Date(r.created_at).toISOString().slice(0, 10) })),
    freigaben, kurve
  };
  return { quartal, plan, nutzung, lern, highlights };
}

// ── KI-Anteil: nur Kennzahlen, keine Namen und keine Textinhalte ──
function kiEingabe(d) {
  return {
    paket: d.plan,
    quartal: d.quartal,
    nutzung: {
      texteImQuartal: d.nutzung.total, texteImVorquartal: d.nutzung.vorquartal,
      kontingentProQuartal: d.nutzung.kontingentQuartal, auslastungProzent: d.nutzung.auslastungProzent,
      proMonat: d.nutzung.proMonat, textarten: d.nutzung.proArt.slice(0, 8).map(r => ({ textart: r.name, anzahl: r.n }))
    },
    lernstand: { neueRegeln: d.lern.neu, gefestigteRegeln: d.lern.gefestigt, regelnInsgesamt: d.lern.gesamt, kategorien: d.lern.kategorien.slice(0, 8).map(k => ({ kategorie: k.kategorie, neu: k.neu, gefestigt: k.gefestigt })) },
    highlights: { positiveBewertungen: d.highlights.positiv, negativeBewertungen: d.highlights.negativ, freigaben: d.highlights.freigaben, freigabequoteProMonat: d.highlights.kurve }
  };
}

function kiPrompt(d) {
  return `Du bereitest für Lorena, die Beraterin, das Quartalsgespräch mit einem Klienten vor. Unten stehen die Kennzahlen des Quartals als JSON. Das sind alle verfügbaren Daten.
Schreibe:
1. zusammenfassung: drei bis vier Sätze zu Nutzung, Lernstand und Entwicklung.
2. empfehlungen: drei bis fünf kurze Gesprächsimpulse für Lorena, jeder höchstens zwei Sätze.
Regeln: Verwende ausschliesslich die Angaben im JSON. Erfinde keine Zahlen, Namen, Ursachen oder Ereignisse. Wo Daten fehlen oder zu dünn sind (zum Beispiel weniger als drei Freigaben im Monat), sage das offen und schlage vor, im Gespräch nachzufragen. Schreibe Schweizer Rechtschreibung (ss statt ß), keine Gedankenstriche, keine Kursivschrift und nie die Formulierungen «X, nicht Y» oder «nicht X, sondern Y». Sprich von «dem Klienten» oder «der Firma».
Antworte ausschliesslich mit gültigem JSON ohne weiteren Text im Format {"zusammenfassung":"","empfehlungen":["",""]}.

KENNZAHLEN:
${JSON.stringify(kiEingabe(d))}`;
}

function parseKi(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const zus = clean(j.zusammenfassung, 1500);
    const emp = (Array.isArray(j.empfehlungen) ? j.empfehlungen : []).map(x => clean(x, 400)).filter(Boolean).slice(0, 6);
    return zus || emp.length ? { zusammenfassung: zus, empfehlungen: emp } : null;
  } catch { return null; }
}

async function kiText(d, clientId, advisorId, cap = CAP_USD) {
  const user = kiPrompt(d);
  const modell = aiProvider.resolveModelId('haiku');
  // Vorab: schon das geschätzte Volumen darf die Obergrenze nicht sprengen
  if (meter.costUsd({ model: modell, inputTokens: user.length / 3.5 + 200, outputTokens: 900 }) > cap) return { abgebrochen: true, kosten: 0 };
  const resp = await aiProvider.generateText({
    system: [{ type: 'text', text: 'Du schreibst sachlich, freundlich und knapp auf Deutsch (Schweizer Rechtschreibung).' }],
    messages: [{ role: 'user', content: user }], maxTokens: 900, model: modell, temperature: 0.3,
    meter: { module: 'quartalsreview', clientId, advisorId: advisorId || null }
  });
  const kosten = meter.costUsd({ model: resp.model || modell, inputTokens: resp.inputTokens || 0, outputTokens: resp.outputTokens || 0,
    cacheCreationTokens: resp.cacheCreationTokens || 0, cacheReadTokens: resp.cacheReadTokens || 0 });
  if (kosten > cap) return { abgebrochen: true, kosten };
  return { ki: parseKi(resp.text), kosten };
}

// ── Word ──
async function buildAuswertung(clientId, quartal) {
  await ensureSchema();
  const { rows: cr } = await pool.query('SELECT name FROM clients WHERE id=$1', [clientId]);
  if (!cr[0]) throw new Error('Klient nicht gefunden.');
  const lauf = (await pool.query('SELECT ki_json FROM quartalsreview_laeufe WHERE client_id=$1 AND quartal=$2', [clientId, quartal])).rows[0];
  if (!lauf || !lauf.ki_json) throw new Error('Für dieses Quartal gibt es noch keine Auswertung.');
  const gespeichert = JSON.parse(lauf.ki_json);
  const d = gespeichert.daten, ki = gespeichert.ki || {};
  const { FONT, p, h1, bullet, cell } = qr.docHelpers;
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Quartalsauswertung', font: FONT, size: 48, bold: true })] }));
  kids.push(p(`${cr[0].name}, ${quartalLabel(quartal)}`, { size: 28, after: 60 }));
  kids.push(p(`Erstellt am ${new Date(gespeichert.erstelltAm).toLocaleDateString('de-CH')}. Grundlage sind die Daten der Plattform für den Zeitraum des Quartals.`, { size: 20, color: '777777', after: 200 }));

  kids.push(h1('Zusammenfassung'));
  kids.push(p(ki.zusammenfassung || 'Die Zusammenfassung liegt nicht vor. Die Kennzahlen unten gelten trotzdem.'));

  const n = d.nutzung;
  kids.push(h1('1. Nutzung des Quartals'));
  kids.push(p(`Texte und Auswertungen im Quartal: ${n.total} (Vorquartal: ${n.vorquartal})`, { bold: true }));
  n.proMonat.forEach(m => kids.push(bullet(`${m.monat}: ${m.n}`)));
  if (n.kontingentQuartal != null) kids.push(p(`Kontingent: ${n.kontingentMonat} Texte pro Monat (${n.kontingentQuartal} im Quartal), Auslastung ${n.auslastungProzent} Prozent.`));
  else kids.push(p('Das Paket hat kein festes Textkontingent.'));
  if (n.proArt.length) {
    const w = [6000, 3000];
    kids.push(new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: w, rows: [
      new TableRow({ children: [cell('Textart', w[0], true), cell('Anzahl', w[1], true)] }),
      ...n.proArt.slice(0, 12).map(r => new TableRow({ children: [cell(r.name, w[0]), cell(r.n, w[1])] }))
    ] }));
    kids.push(p('', { after: 60 }));
  } else kids.push(p('Im Quartal gab es keine Texte.'));

  const l = d.lern;
  kids.push(h1('2. Lernstand'));
  if (!l.gesamt) kids.push(p('RhetorIQ hat aus den Korrekturen noch keine Regeln gelernt.'));
  else {
    kids.push(p(`Gelernte Regeln insgesamt: ${l.gesamt}. Neu in diesem Quartal: ${l.neu}. Gefestigt (mindestens ${GEFESTIGT_AB} Bestätigungen): ${l.gefestigt}.`, { bold: true }));
    const w = [4500, 1500, 1500, 1500];
    kids.push(new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: w, rows: [
      new TableRow({ children: ['Kategorie', 'Neu', 'Gefestigt', 'Gesamt'].map((t, i) => cell(t, w[i], true)) }),
      ...l.kategorien.slice(0, 12).map(k => new TableRow({ children: [cell(k.kategorie, w[0]), cell(k.neu, w[1]), cell(k.gefestigt, w[2]), cell(k.gesamt, w[3])] }))
    ] }));
    kids.push(p('', { after: 60 }));
    l.regeln.forEach(r => kids.push(bullet(`${r.neu ? 'Neu' : 'Gefestigt'}, ${r.kategorie}: ${r.text}`)));
  }

  const h = d.highlights;
  kids.push(h1('3. Highlights'));
  kids.push(p(`Bewertungen der Texte: ${h.positiv} positiv, ${h.negativ} negativ.`));
  if (h.staerkste.length) { kids.push(p('Stark bewertete Texte:', { bold: true })); h.staerkste.forEach(s => kids.push(bullet(`${s.textart}, ${new Date(s.datum).toLocaleDateString('de-CH')}`))); }
  const fr = h.freigaben || {};
  const frTot = Object.values(fr).reduce((s, x) => s + x, 0);
  if (frTot) kids.push(p(`Freigaben an Lorena: ${frTot} (davon freigegeben: ${fr.approved || 0}).`));
  const ok = (h.kurve || []).filter(m => m.ausreichend);
  if (ok.length >= 2) {
    kids.push(p('Anteil unverändert übernommener Sätze nach Monat:', { bold: true }));
    ok.forEach(m => kids.push(bullet(`${m.monat}: ${m.prozent} Prozent (${m.freigaben} Freigaben)`)));
  } else kids.push(p('Für die Entwicklung der Freigabequote gab es in diesem Quartal noch zu wenige Freigaben (mindestens drei pro Monat sind nötig).'));

  kids.push(h1('4. Empfehlungen für das Gespräch'));
  if ((ki.empfehlungen || []).length) ki.empfehlungen.forEach((e, i) => kids.push(p(`${i + 1}. ${e}`)));
  else kids.push(p('Es liegen keine Empfehlungen vor.'));
  kids.push(p('Die Zusammenfassung und die Empfehlungen sind KI-Entwürfe aus den Kennzahlen. Bitte vor dem Gespräch prüfen.', { size: 20, color: '777777' }));

  const doc = new Document({
    creator: 'RhetorIQ', title: `Quartalsauswertung ${cr[0].name} ${quartal}`,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } }, children: kids }]
  });
  return { buffer: await Packer.toBuffer(doc), name: cr[0].name, quartal };
}

// ── Mails ──
function appUrl() { return (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, ''); }

function beraterinMail({ name, quartal }) {
  const link = `${appUrl()}/`;
  return {
    subject: `RhetorIQ Quartalsauswertung: ${name}, ${quartalLabel(quartal)}`,
    text: `Hallo Lorena\n\nDie Quartalsauswertung für ${name} (${quartalLabel(quartal)}) liegt als Word im Anhang. Zusammenfassung und Empfehlungen sind KI-Entwürfe aus den Kennzahlen.\n\nDen Klienten habe ich zur Terminbuchung eingeladen. Den Termin und deine Notizen pflegst du bei diesem Klienten unter «Quartalsreview» in der Plattform (${link}). Dort kannst du die Auswertung auch erneut als Word laden. Der Status steht jetzt auf «versendet».\n\nRhetorIQ`
  };
}

// Einladung an die Admin-Person der Firma, gesiezt
function klientMail({ kontakt, salutation, lastName, quartal, buchungsUrl }) {
  const gruss = salutation && lastName ? `Guten Tag ${salutation} ${lastName}` : (kontakt ? `Guten Tag ${kontakt}` : 'Guten Tag');
  const termin = buchungsUrl
    ? `Einen Termin können Sie hier direkt buchen:\n${buchungsUrl}\n\nWenn Ihnen keine der Zeiten passt, antworten Sie einfach auf diese E-Mail.`
    : `Antworten Sie einfach auf diese E-Mail mit zwei, drei Terminvorschlägen, die Ihnen passen. Ich bestätige Ihnen gern einen davon.`;
  return {
    subject: `Ihr Quartalsgespräch zu RhetorIQ (${quartalLabel(quartal)})`,
    text: `${gruss}\n\nDas ${quartal.slice(6)}. Quartal ${quartal.slice(0, 4)} ist zu Ende. Ich habe Ihre Nutzung von RhetorIQ ausgewertet und möchte mit Ihnen in einem Gespräch von etwa einer Stunde anschauen, was gut läuft, was RhetorIQ über Ihre Stimme dazugelernt hat und was Sie im nächsten Quartal brauchen.\n\n${termin}\n\nIch freue mich auf den Austausch.\n\nFreundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch`
  };
}

async function adminEmpfaenger(clientId) {
  const [c] = await safe('SELECT name, email, contact, salutation, last_name FROM clients WHERE id=$1', [clientId]);
  if (!c) return null;
  let email = String(c.email || '').trim();
  if (!email) {
    const [u] = await safe(`SELECT email FROM client_users WHERE client_id=$1 AND role='admin' ORDER BY id LIMIT 1`, [clientId]);
    email = u ? String(u.email || '').trim() : '';
  }
  return email ? { email, kontakt: c.contact, salutation: c.salutation, lastName: c.last_name } : null;
}

async function sendeMails(clientId, quartal, lauf, name) {
  const { brevoSend } = require('./brevo');
  const notify = require('./notify');
  const out = { beraterin: false, klient: false };
  // (a) an Lorena mit dem Word im Anhang
  if (!lauf.mail_beraterin_am) {
    const doc = await buildAuswertung(clientId, quartal);
    const m = beraterinMail({ name, quartal });
    const safeName = String(name).replace(/[^A-Za-z0-9ÄÖÜäöüéèàç _-]/g, '').trim().replace(/\s+/g, '_') || 'Klient';
    let gesendet = 0;
    for (const to of notify.advisorEmails()) {
      try {
        await brevoSend({ to, subject: m.subject, text: m.text, senderName: 'RhetorIQ', attachments: [{ name: `Quartalsauswertung_${safeName}_${quartal}.docx`, contentBase64: doc.buffer.toString('base64') }] });
        gesendet++;
      } catch (e) { console.error('[quartalsreview] Mail an Beraterin fehlgeschlagen:', e.message); }
    }
    if (gesendet) {
      await pool.query('UPDATE quartalsreview_laeufe SET mail_beraterin_am=NOW(), updated_at=NOW() WHERE client_id=$1 AND quartal=$2', [clientId, quartal]);
      out.beraterin = true;
    }
  } else out.beraterin = true;
  // (b) Einladung an die Admin-Person der Firma
  if (!lauf.mail_klient_am) {
    const emp = await adminEmpfaenger(clientId);
    if (emp) {
      const m = klientMail({ kontakt: emp.kontakt, salutation: emp.salutation, lastName: emp.lastName, quartal, buchungsUrl: (process.env.QUARTALSREVIEW_BUCHUNGS_URL || '').trim() });
      try {
        await brevoSend({ to: emp.email, subject: m.subject, text: m.text, senderName: 'Lorena Lienhard' });
        await pool.query('UPDATE quartalsreview_laeufe SET mail_klient_am=NOW(), updated_at=NOW() WHERE client_id=$1 AND quartal=$2', [clientId, quartal]);
        out.klient = true;
      } catch (e) { console.error('[quartalsreview] Mail an Klient fehlgeschlagen:', e.message); }
    } else console.error(`[quartalsreview] Klient ${clientId}: keine Admin-Mailadresse, keine Einladung`);
  } else out.klient = true;
  return out;
}

// ── Lauf für einen Klienten ──
// status: fertig | vorschau (erstellt, nicht versendet) | uebersprungen | abgebrochen | fehler | mailfehler. Einmal pro Klient und Quartal (eindeutiger Index).
// Nur Fehler und Abbrüche (und unvollständig oder noch nicht versendete Mails) dürfen wiederholt werden. opts.wiederholen setzt einen fertigen Lauf neu auf.
async function runForClient(clientId, opts = {}) {
  await ensureSchema();
  const now = opts.now || new Date();
  const quartal = opts.quartal || vorherigesQuartal(now);
  const cap = opts.capUsd || CAP_USD;
  const [c] = await safe('SELECT id, name, advisor_id FROM clients WHERE id=$1 AND geloescht_am IS NULL', [clientId]);
  if (!c) return { status: 'fehler', grund: 'Klient nicht gefunden.', quartal };

  let prev = (await pool.query('SELECT * FROM quartalsreview_laeufe WHERE client_id=$1 AND quartal=$2', [clientId, quartal])).rows[0];
  if (prev && opts.wiederholen && !['laeuft'].includes(prev.status)) {
    await pool.query('DELETE FROM quartalsreview_laeufe WHERE id=$1', [prev.id]);
    prev = null;
  }
  if (prev && prev.status === 'laeuft') return { status: 'uebersprungen', grund: 'Der Lauf ist im Gang.', quartal };
  if (prev && prev.status === 'fertig') return { status: 'uebersprungen', grund: 'Für dieses Quartal gibt es schon eine Auswertung.', quartal };

  let lauf = prev;
  if (prev) {
    const up = await pool.query(`UPDATE quartalsreview_laeufe SET status='laeuft', updated_at=NOW() WHERE id=$1 AND status IN ('fehler','abgebrochen','mailfehler','vorschau') RETURNING *`, [prev.id]);
    if (!up.rows.length) return { status: 'uebersprungen', grund: 'Der Lauf ist im Gang.', quartal };
    lauf = up.rows[0];
  } else {
    try { lauf = (await pool.query(`INSERT INTO quartalsreview_laeufe (client_id, quartal, status) VALUES ($1,$2,'laeuft') RETURNING *`, [clientId, quartal])).rows[0]; }
    catch { return { status: 'uebersprungen', grund: 'Der Lauf ist im Gang.', quartal }; }
  }
  let kosten = Number(lauf.kosten_usd) || 0;
  const finish = async (status, extra = {}) => {
    await pool.query('UPDATE quartalsreview_laeufe SET status=$1, kosten_usd=$2, grund=$3, updated_at=NOW() WHERE id=$4', [status, kosten, extra.grund || null, lauf.id]).catch(() => {});
    return { status, kosten, quartal, ...extra };
  };
  try {
    // Die Kennzahlen und der KI-Text werden einmal erzeugt und gespeichert. Ein Wiederholungslauf nach einem Mailfehler ruft die KI nicht erneut auf.
    if (!lauf.ki_json) {
      const daten = await sammle(clientId, quartal);
      const r = await kiText(daten, clientId, c.advisor_id, cap);
      kosten += r.kosten || 0;
      if (r.abgebrochen) return await finish('abgebrochen', { grund: 'Kostenobergrenze erreicht.' });
      await pool.query('UPDATE quartalsreview_laeufe SET ki_json=$1, kosten_usd=$2, updated_at=NOW() WHERE id=$3',
        [JSON.stringify({ daten, ki: r.ki, erstelltAm: new Date().toISOString() }), kosten, lauf.id]);
      lauf.ki_json = 'x';
    }
    if (opts.mails === false) return await finish('vorschau', { mails: false });
    const frisch = (await pool.query('SELECT * FROM quartalsreview_laeufe WHERE id=$1', [lauf.id])).rows[0];
    const mails = await sendeMails(clientId, quartal, frisch, c.name);
    if (mails.beraterin) {
      // Status des Reviews auf «versendet» (ein bereits erledigter Review bleibt erledigt)
      const rev = await qr.getOne(clientId, quartal);
      if (!rev || rev.status !== 'erledigt') await qr.save(clientId, quartal, { status: 'versendet' });
      await pool.query('UPDATE quartalsreviews SET versendet_am=NOW() WHERE client_id=$1 AND quartal=$2', [clientId, quartal]).catch(() => {});
    }
    if (!mails.beraterin || !mails.klient) return await finish('mailfehler', { mails, grund: 'Mindestens eine Mail konnte nicht gesendet werden.' });
    return await finish('fertig', { mails });
  } catch (e) {
    console.error('[quartalsreview] Klient', clientId, e.message);
    return await finish('fehler', { grund: e.message });
  }
}

module.exports = {
  CAP_USD, GEFESTIGT_AB, vorherigesQuartal, quartalRange, davor, berechtigte, sammle, kiEingabe, parseKi, buildAuswertung,
  klientMail, beraterinMail, adminEmpfaenger, runForClient, schweiz
};
