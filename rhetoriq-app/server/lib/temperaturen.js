// Temperatur (Zufallsgrad) der KI je Modul. Nutzbar über opts.temperature von lib/aiProvider.
// Begründung: Ohne Angabe läuft jeder Aufruf mit der Standardtemperatur des Anbieters (typisch 1.0), was die Streuung
// und die Neigung zu Floskeln erhöht. Es gibt keinen Prüfsatz, deshalb gibt es nur zwei vorsichtige Werte:
//   0.7 für Texte, die in der Stimme des Klienten entstehen (genug Spielraum für Rhythmus und Wortwahl, weniger Streuung als 1.0)
//   0.2 für Analyse- und Prüfmodule (Risiko, Sprache, Umsetzbarkeit, Profil), die möglichst gleich und sachlich antworten sollen
// Die Wirkung ist NICHT gemessen. Alle anderen Module (zum Beispiel Brand-Voice-Analyse, Router) bleiben ohne Angabe.
const TEMPERATUR = { text: 0.7, analyse: 0.2 };

// Modulschlüssel aus routes/analyze.js
const TEXT_MODULES = new Set([
  'text-gen', 'ghostwriter', 'before-after', 'rh-translate', 'presentation', 'pr', 'rw', 'brief', 'crisis-toolkit', 'crisis',
  'ht-guest-letter', 'ht-review-response', 'ht-crisis-comm', 'ht-positioning', 'ht-sales-pitch', 'customer-review', 'vs-gen', 'tc'
]);
const ANALYSE_MODULES = new Set([
  'rm',            // Risk Management
  'la',            // Language Analytics
  'as',            // Actionability Scanner
  'rp', 'cf',      // Profiling: Executive Rhetoric Profiling, Communication Fingerprint
  'health-score', 'competitive-check'
]);

// Gibt die Temperatur für ein Modul zurück oder undefined (dann gilt die Standardeinstellung des Anbieters)
function temperaturFor(module) {
  if (TEXT_MODULES.has(module)) return TEMPERATUR.text;
  if (ANALYSE_MODULES.has(module)) return TEMPERATUR.analyse;
  return undefined;
}

module.exports = { TEMPERATUR, TEXT_MODULES, ANALYSE_MODULES, temperaturFor };
