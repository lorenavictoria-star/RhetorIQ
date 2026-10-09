// Lokaler Lint für erzeugte Texte. Reine Funktionen, keine KI, keine Kosten.
// Findet Formfehler, die das Regelwerk (lib/promptRules.js) verbietet, und liefert Treffer mit Position und Art.
// Der Lint ersetzt den zweiten Durchgang nicht. Er gibt ihm eine präzise Liste («Behebe genau diese Punkte»)
// und zeigt am Ende, was nach dem Durchgang noch übrig ist.

const ART_LABEL = {
  gedankenstrich: 'Gedankenstrich',
  eszett: 'ß',
  floskel: 'Floskel',
  fuellwort: 'Füllwort',
  gegenueberstellung: 'Gegenüberstellung',
  anrede: 'gemischte Anrede',
  gendern: 'Gendern mit Sonderzeichen',
  markdown: 'Markdown'
};

// Floskeln aus den Regeln der Prompts (deutsch und englisch)
const FLOSKELN = [
  /es ist wichtig,? zu (?:betonen|erwähnen|beachten)/gi,
  /ein zentraler aspekt dabei ist/gi,
  /in der heutigen (?:schnelllebigen |digitalen |modernen )?(?:welt|zeit)/gi,
  /in einer welt, in der/gi,
  /zusammenfassend lässt sich sagen/gi,
  /das zeigt deutlich/gi,
  /letztlich bedeutet das/gi,
  /dies könnte hilfreich sein, um/gi,
  /ein guter weg, dies zu erreichen, ist/gi,
  /wir hoffen,? (?:dass )?es ihnen gut geht/gi,
  /wir freuen uns,? ihnen mitteilen zu (?:dürfen|können)/gi,
  /wir möchten sie hiermit informieren/gi,
  /viele (?:menschen|experten) sind sich einig/gi,
  /it(?:'|’)?s important to (?:note|mention|highlight)/gi,
  /in today(?:'|’)?s (?:fast-paced )?world/gi,
  /at the end of the day/gi,
  /we hope this (?:message|email) finds you well/gi
];
// Füllwörter: nur melden, nicht bewerten
const FUELLWOERTER = [/\bmehrwert(?:e|es|s)?\b/gi];

function isGerman(sprache) {
  if (!sprache) return true;
  return !/^(en|eng|english|englisch|fr|franz|french|it|ital)/i.test(String(sprache).trim());
}

// Die Anrede aus dem Ton-Etikett lesen («Geschäftlich · Sie»), sonst unbekannt
function anredeAusTon(tone) {
  const t = String(tone || '');
  if (/·\s*Sie\b|\bSie-Form\b|\bsiezen\b/i.test(t)) return 'sie';
  if (/·\s*Du\b|\bDu-Form\b|\bduzen\b/i.test(t)) return 'du';
  return null;
}

function normAnrede(a) {
  const x = String(a || '').trim().toLowerCase();
  if (x === 'sie' || x === 'siezen') return 'sie';
  if (x === 'du' || x === 'duzen') return 'du';
  return null;
}

function findAll(text, re, art, extra = {}) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(text))) {
    out.push({ art, pos: m.index, len: m[0].length, text: m[0], ...extra });
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}

// Wörter der Sie- und der Du-Form. Grossgeschriebenes «Sie» am Satzanfang ist mehrdeutig («sie» als Pronomen) und zählt nicht.
function anredeTreffer(text) {
  const sie = [];
  const du = [];
  const reSie = /\b(?:Sie|Ihnen|Ihr|Ihre|Ihrem|Ihren|Ihrer|Ihres)\b/g;
  const reDu = /\b(?:du|dich|dir|dein|deine|deinem|deinen|deiner|deines)\b/gi;
  let m;
  while ((m = reSie.exec(text))) {
    // Satzanfang oder Zeilenanfang ist mehrdeutig («Sie» kann auch «sie» heissen) und zählt nicht
    const davor = text.slice(0, m.index).replace(/[ \t]+$/, '');
    if (!davor || /[.!?:»«"\n]$/.test(davor)) continue;
    sie.push({ art: 'anrede', pos: m.index, len: m[0].length, text: m[0], form: 'Sie' });
  }
  while ((m = reDu.exec(text))) du.push({ art: 'anrede', pos: m.index, len: m[0].length, text: m[0], form: 'du' });
  return { sie, du };
}

function gendernTreffer(text) {
  const res = [];
  const muster = [
    /[A-Za-zäöüÄÖÜ]\*(?:innen|in)\b/g,
    /[A-Za-zäöüÄÖÜ]:(?:innen|in)\b/g,
    /[A-Za-zäöüÄÖÜ]_(?:innen|in)\b/g,
    /[A-Za-zäöüÄÖÜ]\/-?(?:innen|in)\b/g,
    /[a-zäöüß]I(?:nnen)\b/g
  ];
  for (const re of muster) res.push(...findAll(text, re, 'gendern'));
  return res;
}

function markdownTreffer(text) {
  const res = [];
  res.push(...findAll(text, /\*\*[^*\n]+\*\*/g, 'markdown', { was: 'Fettschrift mit Sternchen' }));
  res.push(...findAll(text, /__[^_\n]+__/g, 'markdown', { was: 'Fettschrift mit Unterstrichen' }));
  res.push(...findAll(text, /^#{1,6}\s+\S/gm, 'markdown', { was: 'Überschrift mit Doppelkreuz' }));
  // Aufzählung mit Stern oder Plus. Der Bindestrich mit Leerzeichen ist laut Regelwerk erlaubter Klartext.
  res.push(...findAll(text, /^[ \t]*[*+•]\s+\S/gm, 'markdown', { was: 'Aufzählungszeichen' }));
  res.push(...findAll(text, /^\s*-{3,}\s*$/gm, 'markdown', { was: 'Trennlinie' }));
  res.push(...findAll(text, /^\s*\|.*\|\s*$/gm, 'markdown', { was: 'Tabelle' }));
  res.push(...findAll(text, /`[^`\n]+`/g, 'markdown', { was: 'Backticks' }));
  return res;
}

function lintText(text, opts = {}) {
  const t = String(text || '');
  if (!t) return [];
  const deutsch = isGerman(opts.sprache);
  let hits = [];
  hits.push(...findAll(t, /[–—]/g, 'gedankenstrich'));
  if (deutsch) hits.push(...findAll(t, /ß/g, 'eszett'));
  for (const re of FLOSKELN) hits.push(...findAll(t, re, 'floskel'));
  for (const re of FUELLWOERTER) hits.push(...findAll(t, re, 'fuellwort', { weich: true }));
  hits.push(...findAll(t, /\bnicht\s+(?!nur\b)[^.,;:!?\n]{1,60}?,?\s+sondern\b/gi, 'gegenueberstellung'));
  hits.push(...gendernTreffer(t));
  hits.push(...markdownTreffer(t));
  if (deutsch) {
    const { sie, du } = anredeTreffer(t);
    const soll = normAnrede(opts.anrede);
    if (soll === 'sie') hits.push(...du);
    else if (soll === 'du') hits.push(...sie);
    else if (sie.length && du.length) hits.push(...(sie.length <= du.length ? sie : du));
  }
  hits.sort((a, b) => a.pos - b.pos);
  // Zeile und kurzer Kontext für die Anzeige
  for (const h of hits) {
    h.kontext = t.slice(Math.max(0, h.pos - 25), Math.min(t.length, h.pos + h.len + 25)).replace(/\s+/g, ' ').trim();
  }
  return hits;
}

// Optionen aus den Eingabedaten eines Auftrags
function lintOptionenAusDaten(data) {
  const d = data || {};
  return { sprache: d.language || null, anrede: normAnrede(d.anrede) || anredeAusTon(d.tone) };
}

// Kurze, präzise Liste für den zweiten Durchgang («Behebe genau diese Punkte»). Weiche Treffer (Füllwörter) bleiben draussen.
function pruefAuftragAusTreffern(hits) {
  const list = (hits || []).filter(h => !h.weich);
  if (!list.length) return '';
  const zeilen = list.slice(0, 12).map(h => {
    const was = h.was ? ` (${h.was})` : '';
    const form = h.form ? ` (${h.form}-Form)` : '';
    return `- ${ART_LABEL[h.art] || h.art}${was}${form}: «${h.kontext}»`;
  });
  const mehr = list.length > 12 ? `\n- und ${list.length - 12} weitere gleicher Art` : '';
  return `\n\nMASCHINELLE PRÜFUNG des Entwurfs. Behebe genau diese Punkte, alles andere bleibt unverändert:\n${zeilen.join('\n')}${mehr}`;
}

// Zusammenfassung für die Anzeige: {n, arten:[Etikett,...]} oder null
function lintZusammenfassung(hits) {
  if (!hits || !hits.length) return null;
  const arten = [];
  for (const h of hits) { const l = ART_LABEL[h.art] || h.art; if (!arten.includes(l)) arten.push(l); }
  return { n: hits.length, arten, text: `Prüfhinweis: ${hits.length} ${hits.length === 1 ? 'Stelle' : 'Stellen'} (${arten.join(', ')})` };
}

// Module mit maschinellem Ergebnis (JSON, Kurztexte) werden nicht geprüft
const LINT_SKIP = new Set(['router', 'route-fill', 'suggest-subject', 'suggest-title', 'consolidate-feedback', 'presentation-preflight', 'chat']);

// Kurze Aufrufe für analyze.js: Liste für den zweiten Durchgang und Zusammenfassung für die Anzeige
function lintFuerDurchgang(entwurf, data, module) {
  if (LINT_SKIP.has(module)) return '';
  return pruefAuftragAusTreffern(lintText(entwurf, lintOptionenAusDaten(data)));
}
function lintErgebnis(text, data, module) {
  if (LINT_SKIP.has(module)) return null;
  return lintZusammenfassung(lintText(text, lintOptionenAusDaten(data)));
}

module.exports = { lintFuerDurchgang, lintErgebnis, LINT_SKIP, lintText, lintOptionenAusDaten, pruefAuftragAusTreffern, lintZusammenfassung, ART_LABEL, anredeAusTon };
