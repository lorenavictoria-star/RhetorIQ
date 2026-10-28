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
  alleinstellung: 'Behauptung ohne Beleg',
  anrede: 'gemischte Anrede',
  gendern: 'Gendern mit Sonderzeichen',
  komma_und: 'Komma vor «und»',
  amerikanisch: 'American spelling (British English required)',
  buerosprech_en: 'corporate filler',
  markdown: 'Markdown'
};

// Floskeln aus den Regeln der Prompts (deutsch und englisch)
const GEGENUEBERSTELLUNG_FREI = { speech: 3, linkedin: 1, website: 1, newsletter: 1 };
const ALLEINSTELLUNG = [
  /\bals\s+erste[rsn]?\s+(?:in|der|im|auf|Anbieter)\b/gi,
  /\bals\s+einzige[rsnm]?\b/gi,
  /\beinzige[rsnm]?\s+Anbieter\b/gi,
  /\bMarktführer\w*|\bführende[rsnm]?\s+(?:Anbieter|Unternehmen)\b/gi,
  /\bbeste[rsnm]?\s+(?:Service|Qualität|Anbieter|Preis)\w*|\bhöchste[rsnm]?\s+Qualität\b|\bNummer\s+(?:1|eins)\b/gi
];
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
  const reDu = /\b(?:du|dich|dir|dein|deine|deinem|deinen|deiner|deines|euch|eure|eurem|euren|eurer|eures)\b/gi;
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

// Komma vor «und»: Schweizer Schreibweise setzt dort keines. Ein Komma bleibt, wo «und» auf das Ende eines Nebensatzes folgt.
// Die Prüfung meldet nur sichere Fälle: Steht im selben Satzteil vor dem Komma ein Einleiter eines Nebensatzes oder ein Relativwort,
// oder folgt auf «und» ein solcher Einleiter, bleibt das Komma unbeanstandet.
const NEBENSATZ_EINLEITER = /\b(?:dass|weil|wenn|ob|obwohl|damit|sodass|so\s+dass|während|bevor|nachdem|falls|sobald|solange|indem|ehe|seit|seitdem|bis|wie|welche[rsnm]?|dessen|deren|wo|womit|wodurch|wofür|worauf|woran|wobei|wonach|weshalb|warum|wann|wer|was)\b/i;
function kommaUndTreffer(t) {
  const res = [];
  const re = /,[ \t]+und\b(?=[ \t]+(\S+))/gi;
  let m;
  while ((m = re.exec(t))) {
    const pos = m.index;
    // Satzteil vor dem Komma: ab dem letzten Satzende oder Zeilenanfang
    const von = Math.max(t.lastIndexOf('.', pos), t.lastIndexOf('!', pos), t.lastIndexOf('?', pos), t.lastIndexOf('\n', pos), t.lastIndexOf(':', pos)) + 1;
    const davor = t.slice(von, pos);
    const danach = (m[1] || '').replace(/[^A-Za-zÄÖÜäöüß]/g, '');
    if (NEBENSATZ_EINLEITER.test(davor)) continue;           // Komma schliesst vermutlich einen Nebensatz oder Einschub
    if (/^(?:dass|weil|wenn|ob|damit|obwohl|sodass|während|falls)$/i.test(danach)) continue;
    if (davor.includes(',')) continue;                       // früheres Komma im Satzteil: Nebensatz, Einschub oder Reihung, nicht eindeutig
    res.push({ art: 'komma_und', pos, len: m[0].length, text: m[0] });
  }
  return res;
}


// ── Englisch (British English, Corporate): eigene Prüfung, nur wenn der Auftrag auf Englisch ist ──
function isEnglish(sprache) { return /^(en|eng|english|englisch)/i.test(String(sprache || '').trim()); }
const US_WOERTER = /\b(?:colors?|colored|coloring|favorites?|favorite|behaviors?|neighbors?|honors?|labor|flavors?|harbors?|centers?|defense|traveling|traveled|catalog(?:s|ed)?|gray|fulfillment|enrollment|skillful|licen[cs]ing|analy[sz]e[sd]?|analyzing|organi[sz]ation(?:s|al)?|(?:organi|recogni|realiz|optimi|summari|prioriti|finali|customi|utili|minimi|maximi|speciali|standardi|authori|categori|capitali|emphasi|apologi|criticiz|civiliz|memori|mobili|modern|normal|personal|visual|digital|energi|harmoni|synchroni|legali|localiz|centrali)[sz](?:e|es|ed|ing|ation|ations)?)\b/gi;
const BRITISCH_OK = /^(?:organis|recognis|realis|optimis|summaris|prioritis|finalis|customis|utilis|minimis|maximis|specialis|standardis|authoris|categoris|capitalis|emphasis|apologis|criticis|civilis|memoris|mobilis|modernis|normalis|personalis|visualis|digitalis|energis|harmonis|synchronis|legalis|localis|centralis|analys|colour|favour|behaviour|neighbour|honour|labour|flavour|harbour|centre|defence|travelling|travelled|catalogue|grey|licens|fulfil)/i;
function amerikanischTreffer(t) {
  const res = [];
  let m;
  US_WOERTER.lastIndex = 0;
  while ((m = US_WOERTER.exec(t))) {
    const w = m[0];
    if (BRITISCH_OK.test(w) && !/^(?:analyz|center|color|favorite|behavior|neighbor|honor|labor|flavor|harbor|defense|traveling|traveled|catalog|gray|fulfillment|enrollment)/i.test(w)) continue;
    // «-ise»-Wörter sind britisch; nur die «-ize»-Formen und die genannten amerikanischen Wörter treffen
    if (/(?:iz|yz)(?:e|es|ed|ing|ation|ations)?$/i.test(w) || /^(?:colors?|colored|coloring|favorites?|behaviors?|neighbors?|honors?|labor|flavors?|harbors?|centers?|defense|traveling|traveled|catalog(?:s|ed)?|gray|fulfillment|enrollment|skillful|analyzing|analyzed|analyzes)$/i.test(w)) {
      res.push({ art: 'amerikanisch', pos: m.index, len: w.length, text: w });
    }
  }
  return res;
}
const BUEROSPRECH_EN = [
  /\bleverag(?:e|es|ed|ing)\b/gi, /\bsynerg(?:y|ies)\b/gi, /\bcircle back\b/gi, /\btouch base\b/gi, /\bgoing forward\b/gi,
  /\bbest-in-class\b/gi, /\bdelv(?:e|es|ed|ing) into\b/gi, /\bgame-?chang(?:er|ing)\b/gi, /\bcutting-edge\b/gi, /\bseamless(?:ly)?\b/gi,
  /\bholistic(?:ally)?\b/gi, /\butili[sz](?:e|es|ed|ing)\b/gi, /\bfacilitat(?:e|es|ed|ing)\b/gi, /\bcommenc(?:e|es|ed|ing)\b/gi,
  /\bI am writing to (?:inform|let) you\b/gi, /\bplease do not hesitate to\b/gi, /\bdo not hesitate to (?:reach out|contact)\b/gi,
  /\bit(?:'|’)?s important to (?:note|remember)\b/gi, /\bin conclusion\b/gi
];
const GEGENUEBER_EN = [
  /\b(?:it|this|that)(?:'|’)?s\s+not\s+(?:just\s+|only\s+|about\s+)?[^.,;:!?\n]{1,60}?[,;.]?\s+(?:it|this|that)(?:'|’)?s\b/gi,
  /\bnot\s+(?:just|merely|simply)\s+[^.!?\n]{1,60}?,?\s+but\b/gi,
  /\bless\s+[a-z]+(?:\s+[a-z]+)?,\s+more\s+[a-z]+/gi
];
function englischTreffer(t) {
  let hits = [];
  hits.push(...amerikanischTreffer(t));
  for (const re of BUEROSPRECH_EN) hits.push(...findAll(t, re, 'buerosprech_en'));
  for (const re of GEGENUEBER_EN) hits.push(...findAll(t, re, 'gegenueberstellung'));
  return hits;
}

function lintText(text, opts = {}) {
  const t = String(text || '');
  if (!t) return [];
  const deutsch = isGerman(opts.sprache);
  let hits = [];
  // Langer Gedankenstrich (—) nie. Kurzer Strich (–) nur in Titelzeilen und zwischen Zahlen (10–12).
  for (const h of findAll(t, /[–—]/g, 'gedankenstrich')) {
    if (h.text === '–') {
      const von = t.lastIndexOf('\n', h.pos) + 1, bis = (t.indexOf('\n', h.pos) + 1 || t.length + 1) - 1;
      const zeile = t.slice(von, bis).trim();
      const zwischenZahlen = /\d$/.test(t.slice(0, h.pos)) && /^\d/.test(t.slice(h.pos + 1));
      const titel = t.includes('\n') && zeile.length > 0 && zeile.length <= 100 && !/[.!?:;]/.test(zeile);
      if (zwischenZahlen || titel) continue;
    }
    hits.push(h);
  }
  if (deutsch) hits.push(...findAll(t, /ß/g, 'eszett'));
  if (deutsch) hits.push(...kommaUndTreffer(t));
  for (const re of FLOSKELN) hits.push(...findAll(t, re, 'floskel'));
  for (const re of FUELLWOERTER) hits.push(...findAll(t, re, 'fuellwort', { weich: true }));
  hits.push(...findAll(t, /\bnicht\s+(?!nur\b)[^.,;:!?\n]{1,60}?,?\s+sondern\b/gi, 'gegenueberstellung'));
  // weitere Formen der Gegenüberstellung: «Das ist kein X. Das ist Y.», «Kein X. Ein Y.», «kein X - sondern Y», «..., nicht per Mail.»
  hits.push(...findAll(t, /\bkein(?:e|en|em|er|es)?\b[^.!?\n]{1,70}?(?:[.;:,]|\s[-–—])\s*(?:sondern|(?:es|das)\s+(?:ist|sind|war|waren|bleibt|bedeutet))\b/gi, 'gegenueberstellung'));
  hits.push(...findAll(t, /\bkein(?:e|en|em|er|es)?\b[^.!?\n]{1,50}?\s[-–—]\s*(?:es|das)\s+\w+/gi, 'gegenueberstellung'));
  hits.push(...findAll(t, /(?:^|[.!?]\s+)Kein(?:e|en)?\s+[^.!?\n]{1,40}[.]\s+Ein(?:e|en)?\b/g, 'gegenueberstellung'));
  hits.push(...findAll(t, /,\s+nicht\s+(?:per|durch|als|mit|wegen|über|nur\s+noch)\s+\w+(?:\s+\w+){0,2}[.!]/gi, 'gegenueberstellung'));
  // Alleinstellung und Superlative nur, wenn der Auftrag sie belegt (steht im Auftrag oder im Hinweis dieselbe Aussage, gilt sie als belegt)
  for (const re of ALLEINSTELLUNG) {
    for (const h of findAll(t, re, 'alleinstellung')) {
      const kern = h.text.toLowerCase().replace(/\s+/g, ' ');
      if (opts.belege && String(opts.belege).toLowerCase().includes(kern.split(' ')[0] === 'als' ? kern.split(' ').slice(0, 2).join(' ') : kern.split(' ')[0])) continue;
      hits.push(h);
    }
  }
  if (isEnglish(opts.sprache)) hits.push(...englischTreffer(t));
  hits.push(...gendernTreffer(t));
  hits.push(...markdownTreffer(t));
  if (deutsch) {
    const { sie, du } = anredeTreffer(t);
    const soll = normAnrede(opts.anrede);
    if (soll === 'sie') hits.push(...du);
    else if (soll === 'du') hits.push(...sie);
    else if (sie.length && du.length) hits.push(...(sie.length <= du.length ? sie : du));
  }
  if (opts.erlaubt && opts.erlaubt.size) hits = hits.filter(h => !opts.erlaubt.has(h.art));
  // Gegenüberstellungen je Textart: Rede und Präsentation dürfen einige setzen, Marketingtexte eine, Mails und Briefe keine
  const frei = GEGENUEBERSTELLUNG_FREI[opts.textart] != null ? GEGENUEBERSTELLUNG_FREI[opts.textart] : 0;
  const gg = hits.filter(h => h.art === 'gegenueberstellung');
  if (gg.length && gg.length <= frei) hits = hits.filter(h => h.art !== 'gegenueberstellung');
  hits.sort((a, b) => a.pos - b.pos);
  // Zeile und kurzer Kontext für die Anzeige
  for (const h of hits) {
    h.kontext = t.slice(Math.max(0, h.pos - 25), Math.min(t.length, h.pos + h.len + 25)).replace(/\s+/g, ' ').trim();
  }
  return hits;
}

// Optionen aus den Eingabedaten eines Auftrags
function lintOptionenAusDaten(data, erlaubt, extra) {
  const d = data || {};
  const o = { sprache: d.language || null, anrede: normAnrede(d.anrede) || anredeAusTon(d.tone) };
  if (erlaubt && erlaubt.size) o.erlaubt = erlaubt;
  if (extra && extra.textart) o.textart = extra.textart;
  if (extra && extra.belege) o.belege = extra.belege;
  return o;
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
function lintFuerDurchgang(entwurf, data, module, erlaubt, extra) {
  if (LINT_SKIP.has(module)) return '';
  return pruefAuftragAusTreffern(lintText(entwurf, lintOptionenAusDaten(data, erlaubt, extra)));
}
function lintErgebnis(text, data, module, erlaubt, extra) {
  if (LINT_SKIP.has(module)) return null;
  return lintZusammenfassung(lintText(text, lintOptionenAusDaten(data, erlaubt, extra)));
}

module.exports = { englischTreffer, isEnglish, anredeTreffer, lintFuerDurchgang, lintErgebnis, LINT_SKIP, lintText, lintOptionenAusDaten, pruefAuftragAusTreffern, lintZusammenfassung, ART_LABEL, anredeAusTon };
