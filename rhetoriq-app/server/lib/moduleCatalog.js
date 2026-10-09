// Modulnamen der Plattform, Sektor-Zuordnung und Schlüssel für enabled_modules.
// Die Sektorlisten entsprechen SECMODS im Designbaukasten.

const ALLE_MODULE = [
  'Brand Voice', 'Text Generator', 'Varianten-Generator', 'Situations-Variante',
  'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Risiko-Scan',
  'Klarheits-Check', 'Notizen zu Aufgaben', 'Einwand-Training', 'Debrief',
  'Gespräch', 'Rede und Auftritt', 'Bewertungen beantworten',
  'Branchenpaket Hotellerie', 'Branchenpaket Capital Markets'
];

const SEKTOR_NAME = {
  kmu: 'KMU / Allgemein', hotellerie: 'Hotellerie / Tourismus', capital: 'Capital / Finance',
  bildung: 'Bildung / Public Sector', nonprofit: 'Non-Profit / NGO', tech: 'Tech / Startup',
  beratung: 'Beratung / Coaching'
};

const SECMODS = {
  kmu: ['Text Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Gespräch', 'Risiko-Scan', 'Klarheits-Check', 'Notizen zu Aufgaben'],
  hotellerie: ['Text Generator', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Gespräch'],
  capital: ['Text Generator', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Gespräch', 'Risiko-Scan'],
  bildung: ['Text Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Gespräch', 'Klarheits-Check'],
  nonprofit: ['Text Generator', 'Varianten-Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Gespräch'],
  tech: ['Text Generator', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Gespräch', 'Risiko-Scan', 'Klarheits-Check', 'Notizen zu Aufgaben'],
  beratung: ['Text Generator', 'Varianten-Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Gespräch', 'Risiko-Scan', 'Notizen zu Aufgaben']
};

// Anzeigename -> Schlüssel in clients.enabled_modules (siehe NC_MODULE_LABELS im Frontend).
const MODUL_SCHLUESSEL = {
  'Brand Voice': 'brand-voice',
  'Text Generator': 'text-gen',
  'Varianten-Generator': 'vs-gen',
  'Situations-Variante': 'vs-cal',
  'Kommunikations-Profil': 'profiling',
  'Feedback Writer': 'review',
  'Wertschätzung': 'recognition',
  'Meeting-Vorbereitung': 'pre-meeting',
  'Risiko-Scan': 'risk',
  'Klarheits-Check': 'actionability',
  'Notizen zu Aufgaben': 'thread',
  'Einwand-Training': 'sparring',
  'Debrief': 'debrief'
};

// Gebündelte Module: Ein Name steht für mehrere Einzelschlüssel in enabled_modules.
// Alte Einzelschlüssel bleiben gültig (nichts wird migriert).
// Zuordnung alt zu neu:
//   Gespräch = pre-meeting, arg-reaction, sparring, debrief
//   Rede und Auftritt = text-gen (Textart Rede), presentation
//   Bewertungen beantworten = customer-review (ht-review-response wird nur über das Branchenpaket Hotellerie vergeben)
//   Branchenpaket Hotellerie = ht-* ; Branchenpaket Capital Markets = cm-*
const BUENDEL_SCHLUESSEL = {
  'Gespräch': ['pre-meeting', 'arg-reaction', 'sparring', 'debrief'],
  'Rede und Auftritt': ['text-gen', 'presentation'],
  'Bewertungen beantworten': ['customer-review'],
  'Branchenpaket Hotellerie': ['ht-guest-letter', 'ht-review-response', 'ht-crisis-comm', 'ht-positioning', 'ht-sales-pitch'],
  'Branchenpaket Capital Markets': ['cm-qa-trainer', 'cm-equity-story', 'cm-earnings-analyzer', 'cm-board-coach', 'cm-roadshow']
};

// Wandelt gewählte Modulnamen in enabled_modules um. Brand Voice ist immer dabei.
function toEnabledModules(namen) {
  const keys = new Set(['brand-voice']);
  for (const n of Array.isArray(namen) ? namen : []) {
    if (MODUL_SCHLUESSEL[n]) keys.add(MODUL_SCHLUESSEL[n]);
    if (BUENDEL_SCHLUESSEL[n]) BUENDEL_SCHLUESSEL[n].forEach(k => keys.add(k));
  }
  return [...keys];
}

module.exports = { ALLE_MODULE, SEKTOR_NAME, SECMODS, MODUL_SCHLUESSEL, BUENDEL_SCHLUESSEL, toEnabledModules };
