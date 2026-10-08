// Modulnamen der Plattform, Sektor-Zuordnung und Schlüssel für enabled_modules.
// Die Sektorlisten entsprechen SECMODS im Designbaukasten.

const ALLE_MODULE = [
  'Brand Voice', 'Text Generator', 'Vorher / Nachher', 'Varianten-Generator', 'Situations-Variante',
  'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Risiko-Scan',
  'Klarheits-Check', 'Notizen zu Aufgaben', 'Einwand-Training', 'Debrief'
];

const SEKTOR_NAME = {
  kmu: 'KMU / Allgemein', hotellerie: 'Hotellerie / Tourismus', capital: 'Capital / Finance',
  bildung: 'Bildung / Public Sector', nonprofit: 'Non-Profit / NGO', tech: 'Tech / Startup',
  beratung: 'Beratung / Coaching'
};

const SECMODS = {
  kmu: ['Text Generator', 'Vorher / Nachher', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Risiko-Scan', 'Klarheits-Check', 'Notizen zu Aufgaben'],
  hotellerie: ['Text Generator', 'Vorher / Nachher', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Einwand-Training', 'Debrief'],
  capital: ['Text Generator', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Meeting-Vorbereitung', 'Risiko-Scan', 'Einwand-Training'],
  bildung: ['Text Generator', 'Vorher / Nachher', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Klarheits-Check'],
  nonprofit: ['Text Generator', 'Vorher / Nachher', 'Varianten-Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung'],
  tech: ['Text Generator', 'Vorher / Nachher', 'Varianten-Generator', 'Situations-Variante', 'Kommunikations-Profil', 'Feedback Writer', 'Meeting-Vorbereitung', 'Risiko-Scan', 'Klarheits-Check', 'Notizen zu Aufgaben', 'Einwand-Training'],
  beratung: ['Text Generator', 'Vorher / Nachher', 'Varianten-Generator', 'Kommunikations-Profil', 'Feedback Writer', 'Wertschätzung', 'Meeting-Vorbereitung', 'Risiko-Scan', 'Einwand-Training', 'Debrief', 'Notizen zu Aufgaben']
};

// Anzeigename -> Schlüssel in clients.enabled_modules (siehe NC_MODULE_LABELS im Frontend).
const MODUL_SCHLUESSEL = {
  'Brand Voice': 'brand-voice',
  'Text Generator': 'text-gen',
  'Vorher / Nachher': 'before-after',
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

// Wandelt gewählte Modulnamen in enabled_modules um. Brand Voice ist immer dabei.
function toEnabledModules(namen) {
  const keys = new Set(['brand-voice']);
  for (const n of Array.isArray(namen) ? namen : []) {
    if (MODUL_SCHLUESSEL[n]) keys.add(MODUL_SCHLUESSEL[n]);
  }
  return [...keys];
}

module.exports = { ALLE_MODULE, SEKTOR_NAME, SECMODS, MODUL_SCHLUESSEL, toEnabledModules };
