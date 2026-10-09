// Inventar aller KI-Aufrufe der Plattform mit Auslöser, Modell, typischer Grösse und Kosten je Aufruf.
// Die Schlüssel entsprechen der Spalte module im Nutzungsprotokoll (usage_log, lib/meter.js).
// Alle Tokenzahlen sind SCHÄTZUNGEN aus dem Code (Zeichen geteilt durch 3.5, wie sonst in der Plattform), keine Messwerte.
// Die Preise kommen ausschliesslich aus lib/meter.js (PRICES, costUsd). Echte Kosten zeigt das Nutzungsprotokoll nach dem Deploy.

const { costUsd } = require('./meter');

const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';
const tok = (chars) => Math.ceil(chars / 3.5);

// Auslöser
//  klick:      eine Person drückt einen Knopf, die Antwort ist der Zweck
//  folge:      läuft im Hintergrund nach einem Ereignis (Senden, Nachfrage, Daumen, Feedback), ohne eigenen Klick
//  zeitplan:   Zeitplan des Servers, ohne jeden Klick
//  besucher:   Besucherin der öffentlichen Seite (kein Login)
// automatisch = kein eigener Klick der Person, die die Kosten auslöst.

// Annahmen für den Text-Generator (zwei Durchgänge, Standard)
const A = {
  rules: 4938,            // GLOBAL_STYLE_RULES (Zeichen), gemessen am Code
  base: 785,              // System des Text-Generators (Zeichen), gemessen am Code
  bvHead: 845, bvTail: 106,
  bv: 6000,               // Annahme: Brand Voice eines Klienten
  learnings: 600,         // Annahme: gelernte Vorlieben
  datum: 150,             // heuteBlock
  briefing: 1500,         // Annahme: Briefing
  memory: 8000,           // Annahme: Gedächtnis-Auszug im Auftrag (Obergrenze der Plattform: 40000)
  gold: 3000,             // Obergrenze Goldtexte (BLOCK_LIMIT)
  stilkarte: 400,         // Obergrenze Stilkarte
  ausgabe: 600,           // Annahme: Ausgabe in Tokens (E-Mail, Beitrag, Brief)
  lintAuftrag: 300        // Annahme: Prüfauftrag aus dem Lint im zweiten Durchgang (Zeichen)
};

// Text-Generator mit zwei Durchgängen. opts.cache=false rechnet ohne Zwischenspeicher, opts.zusaetze addiert Goldtexte und Stilkarte.
function textGenZweiDurchgaenge({ cache = true, gold = 0, stilkarte = 0, memory = A.memory } = {}) {
  const sys = tok(A.base + A.bvHead + A.bv + A.bvTail + A.rules + A.learnings + A.datum + gold + stilkarte);
  const user = tok(A.briefing + memory);
  const prefix = sys + user;
  const draft = A.ausgabe, tail = tok(A.lintAuftrag) + 150;
  if (cache) {
    return [
      { model: SONNET, cacheCreationTokens: prefix, outputTokens: A.ausgabe },                         // Durchgang 1 schreibt den Zwischenspeicher
      { model: SONNET, cacheReadTokens: prefix, inputTokens: draft + tail, outputTokens: A.ausgabe }   // Durchgang 2 liest ihn
    ];
  }
  return [
    { model: SONNET, inputTokens: prefix, outputTokens: A.ausgabe },
    { model: SONNET, inputTokens: prefix + draft + tail, outputTokens: A.ausgabe }
  ];
}

// Einzelmodul im ersten und einzigen Durchgang (Sparring, Ghostwriter, Analysen): Zwischenspeicher kalt angenommen
function einzelModul() {
  const cacheable = tok(2000 + A.bvHead + A.bv + A.bvTail);
  const rest = tok(A.rules + A.learnings + A.datum + 3000);
  return [{ model: SONNET, cacheCreationTokens: cacheable, inputTokens: rest, outputTokens: 1200 }];
}
// Nachfrage «Anpassen»: ein Durchgang, Brand-Voice-Teil gelesen (Nachfrage kommt meist innert fünf Minuten)
function nachfrage() {
  const cacheable = tok(2000 + A.bvHead + A.bv + A.bvTail);
  const rest = tok(A.rules + A.learnings + A.datum + A.briefing + A.memory) + A.ausgabe + 150;
  return [{ model: SONNET, cacheReadTokens: cacheable, inputTokens: rest, outputTokens: A.ausgabe }];
}

// auftrag: Menge je Monat im Szenario (10 Klienten, 400 Texte). mengeAnnahme beschreibt die Annahme in Worten.
const INVENTAR = {
  'text-gen': {
    label: 'Text-Generator (zwei Durchgänge)', funktion: 'Entwurf, dann Prüfung gegen Brand Voice und Regeln', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => textGenZweiDurchgaenge(), menge: 340, mengeAnnahme: '85 Prozent der 400 Texte, Standard mit zweitem Durchgang',
    cache: 'Durchgang 1 schreibt, Durchgang 2 liest (System und Auftrag)', haeufigkeit: 'je Text'
  },
  'einzelmodul': {
    label: 'Einzelmodule (Sparring, Ghostwriter, Analysen, Präsentation u. a.)', funktion: 'ein Durchgang', ausloeser: 'klick', modell: 'Sonnet',
    calls: einzelModul, menge: 60, mengeAnnahme: '15 Prozent der 400 Texte',
    cache: 'Basis und Brand Voice markiert; bei seltener Nutzung meist kalt (Schreibzuschlag)', haeufigkeit: 'je Klick'
  },
  'nachfrage': {
    label: 'Nachfrage «Anpassen»', funktion: 'gezielte Überarbeitung des Ergebnisses', ausloeser: 'klick', modell: 'Sonnet',
    calls: nachfrage, menge: 100, mengeAnnahme: 'bei 25 Prozent der Texte',
    cache: 'Brand-Voice-Teil gelesen, wenn innert fünf Minuten', haeufigkeit: 'je Klick'
  },
  'lernen-korrektur': {
    label: 'Lernvorschläge nach dem Senden', funktion: 'Vergleich KI-Text und gesendete Fassung, höchstens 3 Vorlieben', ausloeser: 'folge', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 370 + 340 + 2 * tok(1500) + 100, outputTokens: 200 }], menge: 120, mengeAnnahme: '60 Prozent der Texte werden gesendet, davon die Hälfte genug verändert',
    cache: 'keiner (Haiku, Eingabe unter der Mindestgrösse)', haeufigkeit: 'einmal je gesendeter Freigabe, nur bei Änderung ab 10 Prozent'
  },
  'lernen-nachfrage': {
    label: 'Einordnung einer Nachfrage als Lernvorschlag', funktion: 'Kategorie und allgemeine Vorliebe aus dem Änderungswunsch', ausloeser: 'folge', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 400, outputTokens: 60 }], menge: 100, mengeAnnahme: 'jede Nachfrage mit Daumen nach unten und Text',
    cache: 'keiner', haeufigkeit: 'je Nachfrage'
  },
  'lernen-daumen': {
    label: 'Verfeinerung des Lernstands nach Daumen mit Notiz', funktion: 'Kategorie und Zusammenfassung', ausloeser: 'folge', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 800, outputTokens: 100 }], menge: 60, mengeAnnahme: '15 Prozent der Texte erhalten eine Notiz',
    cache: 'keiner', haeufigkeit: 'je Bewertung mit Notiz'
  },
  'waechter': {
    label: 'KI-Wächter', funktion: 'prüft alle fünf Minuten, ob die KI antwortet', ausloeser: 'zeitplan', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 25, outputTokens: 5 }], menge: 8640, mengeAnnahme: '288 Aufrufe je Tag mal 30 Tage (Stand vor der Änderung)',
    cache: 'keiner', haeufigkeit: 'alle 5 Minuten'
  },
  'comm-profile': {
    label: 'Kommunikationsprofil-Messung', funktion: 'sechs Stilwerte und drei Befunde aus den letzten Texten', ausloeser: 'zeitplan', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 290 + tok(9000), outputTokens: 450 }], menge: 20, mengeAnnahme: '2 Läufe je Monat mal 10 Klienten mit Ausgangslage und mindestens 3 neuen Texten',
    cache: 'keiner', haeufigkeit: 'am 1. und 15. des Monats, je Klient'
  },
  'themenplan': {
    label: 'Themenplan und Newsletter-Entwurf', funktion: '8 bis 10 Themen und ein Newsletter-Entwurf', ausloeser: 'zeitplan', modell: 'Sonnet',
    calls: () => {
      const bv = tok(A.bvHead + A.bv + A.bvTail);
      const rest = tok(7500 + A.rules + 4300);
      return [
        { model: SONNET, cacheCreationTokens: bv, inputTokens: rest, outputTokens: 1500 },
        { model: SONNET, cacheReadTokens: bv, inputTokens: rest + 200, outputTokens: 800 }
      ];
    }, menge: 3, mengeAnnahme: '3 von 10 Klienten haben das Zusatzprodukt (Schätzung), ein Lauf je Monat',
    cache: 'Brand Voice im zweiten Aufruf gelesen', haeufigkeit: 'am 1. des Monats je Klient; Obergrenze 0.50 US-Dollar je Lauf'
  },
  'quartalsreview': {
    label: 'Quartalsauswertung', funktion: 'Zusammenfassung und Empfehlungen aus den Kennzahlen des Quartals (ohne Textinhalte)', ausloeser: 'zeitplan', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 900, outputTokens: 700 }], menge: 4, mengeAnnahme: '4 von 10 Klienten (Business, Enterprise, Zusatz), ein Lauf je Quartal',
    cache: 'keiner', haeufigkeit: 'am 2. Tag nach Quartalsende, je Klient; Obergrenze 0.20 US-Dollar je Lauf'
  },
  'schnelltest': {
    label: 'Stimm-Schnelltest (Landingpage)', funktion: '3 Befunde zu einer Webseite', ausloeser: 'besucher', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 250 + tok(6000), outputTokens: 250 }], menge: 30, mengeAnnahme: '30 Tests je Monat (Obergrenze 150 je Tag)',
    cache: 'keiner', haeufigkeit: 'je Besucherin, höchstens 5 je Stunde und Adresse'
  },
  'website-scan': {
    label: 'Webseiten-Scan im Onboarding', funktion: 'Befunde und Modulempfehlung aus der Webseite', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 570 + tok(12000), outputTokens: 2500 }], menge: 2, mengeAnnahme: '2 neue Klienten je Monat',
    cache: 'keiner', haeufigkeit: 'je Onboarding'
  },
  'memory-vorschlag': {
    label: 'Gedächtnis: Typ des hochgeladenen Dokuments', funktion: 'ordnet ein Dokument einem Typ zu', ausloeser: 'klick', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 260 + tok(2400) + 30, outputTokens: 80 }], menge: 40, mengeAnnahme: '40 Uploads je Monat',
    cache: 'keiner', haeufigkeit: 'je Upload; Eingabe auf 2400 Zeichen gekürzt'
  },
  'onboard': {
    label: 'Onboarding: Dateisortierung', funktion: 'Kategorie und Kurzfassung je Datei', ausloeser: 'klick', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 430 + tok(3000), outputTokens: 100 }], menge: 40, mengeAnnahme: '40 Dateien je Monat',
    cache: 'keiner', haeufigkeit: 'je Datei; Eingabe auf 3000 Zeichen gekürzt'
  },
  'hilfe-chat': {
    label: 'Hilfe-Chat', funktion: 'beantwortet Fragen zur Bedienung', ausloeser: 'klick', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 860 + 200, outputTokens: 250 }], menge: 100, mengeAnnahme: '100 Fragen je Monat',
    cache: 'keiner (Haiku braucht 4096 Tokens für den Zwischenspeicher)', haeufigkeit: 'je Frage, höchstens 10 je Minute'
  },
  'assistent-chat': {
    label: 'Assistent-Chat (Seitenleiste)', funktion: 'allgemeiner Chat mit Verlauf', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 1600 + 1500 + 100, outputTokens: 300 }], menge: 20, mengeAnnahme: '20 Nachrichten je Monat',
    cache: 'keiner', haeufigkeit: 'je Nachricht (Modul-Prompt laut Code Haiku, die Route erzwingt Sonnet)'
  },
  'berater-chat': {
    label: 'Chat im Klienten-Workspace und bei Freigaben', funktion: 'Überarbeitung eines Textes mit Brand Voice als Kontext', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 1400 + 700 + 1500 + 100, outputTokens: 900 }], menge: 60, mengeAnnahme: '60 Nachrichten je Monat',
    cache: 'keiner (System ohne Markierung)', haeufigkeit: 'je Nachricht'
  },
  'feedback-vorschlag': {
    label: 'Lösungsvorschlag zu einer Feedback-Notiz', funktion: 'Vorschlag für Lorena in der Benachrichtigungsmail', ausloeser: 'folge', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 500, outputTokens: 350 }], menge: 20, mengeAnnahme: '20 Feedback-Notizen je Monat',
    cache: 'keiner', haeufigkeit: 'je Feedback-Notiz'
  },
  'modul-prompt': {
    label: 'Modul-Anweisungen verbessern', funktion: 'Haiku formuliert Anweisungen für ein Modul', ausloeser: 'klick', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 600, outputTokens: 300 }], menge: 10, mengeAnnahme: '10 Klicks je Monat',
    cache: 'keiner', haeufigkeit: 'je Klick'
  },
  'custom-module': {
    label: 'Eigene Module vorschlagen', funktion: '4 bis 6 Moduldefinitionen aus Gesprächsnotizen', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 1000, outputTokens: 2500 }], menge: 2, mengeAnnahme: '2 Klicks je Monat',
    cache: 'keiner', haeufigkeit: 'je Klick'
  },
  'selbsttest': {
    label: 'Selbsttest nach Störung', funktion: 'drei kurze Testtexte', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [0, 1, 2].map(() => ({ model: SONNET, inputTokens: 230, outputTokens: 90 })), menge: 2, mengeAnnahme: '2 Läufe je Monat',
    cache: 'keiner', haeufigkeit: 'je Klick, höchstens ein Lauf gleichzeitig'
  },
  'health-score': {
    label: 'Health Score', funktion: 'Bewertung der Nutzung eines Klienten', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => [{ model: SONNET, inputTokens: 2200, outputTokens: 600 }], menge: 15, mengeAnnahme: '15 Klicks je Monat',
    cache: 'keiner', haeufigkeit: 'je Klick'
  },
  'router': {
    label: 'Modul-Router, Betreff- und Titelvorschlag, Präsentations-Vorprüfung', funktion: 'kleine Hilfsaufrufe', ausloeser: 'klick', modell: 'Haiku',
    calls: () => [{ model: HAIKU, inputTokens: 700, outputTokens: 100 }], menge: 260, mengeAnnahme: '60 Router, 80 Titel, 100 Betreffvorschläge, 20 Vorprüfungen (gemittelte Grösse)',
    cache: 'keiner', haeufigkeit: 'je Klick'
  },
  'pruefsatz': {
    label: 'Prüfsatz mit Blindvergleich', funktion: 'bis zu 10 Briefings in zwei Varianten', ausloeser: 'klick', modell: 'Sonnet',
    calls: () => { const a = textGenZweiDurchgaenge(); const b = [{ model: SONNET, inputTokens: tok(A.base + A.bvHead + A.bv + A.bvTail + A.rules + A.learnings + A.datum + A.briefing + A.memory), outputTokens: A.ausgabe }]; return [...a, ...b].flatMap(x => Array(10).fill(x)); },
    menge: 1, mengeAnnahme: '1 Lauf je Monat mit 10 Briefings (harte Grenze 3 US-Dollar je Lauf)',
    cache: 'wie Text-Generator', haeufigkeit: 'je Klick mit Bestätigung'
  }
};

const AUSLOESER_TEXT = {
  klick: 'Klick einer Person',
  folge: 'Hintergrundaufruf nach einem Ereignis',
  zeitplan: 'Zeitplan',
  besucher: 'Besucherin ohne Login'
};
const ist_automatisch = (a) => a !== 'klick';

function kostenJeVorgang(key) {
  const e = INVENTAR[key];
  return e.calls().reduce((s, c) => s + costUsd(c), 0);
}

// Gibt je Funktion Kosten je Vorgang und je Monat im Szenario zurück
function szenario() {
  const rows = Object.keys(INVENTAR).map(key => {
    const e = INVENTAR[key];
    const jeVorgang = kostenJeVorgang(key);
    return { key, ...e, aufrufeJeVorgang: e.calls().length, jeVorgang, jeMonat: jeVorgang * e.menge, automatisch: ist_automatisch(e.ausloeser) };
  });
  const total = rows.reduce((s, r) => s + r.jeMonat, 0);
  const auto = rows.filter(r => r.automatisch).reduce((s, r) => s + r.jeMonat, 0);
  return { rows, total, auto };
}

// Hinweis für die Übersicht «Wohin das KI-Geld fliesst»: gilt auch für Schlüssel, die nicht im Inventar stehen
function info(moduleKey) {
  const e = INVENTAR[moduleKey];
  if (moduleKey === 'ki') return { label: 'Nicht zugeordnet (Hilfsaufrufe ohne Namen)', automatisch: false, ausloeser: null };
  if (!e) return { label: moduleKey, automatisch: false, ausloeser: null };
  return { label: e.label, automatisch: ist_automatisch(e.ausloeser), ausloeser: AUSLOESER_TEXT[e.ausloeser] };
}

module.exports = { INVENTAR, AUSLOESER_TEXT, A, tok, szenario, kostenJeVorgang, textGenZweiDurchgaenge, info, ist_automatisch, SONNET, HAIKU };
