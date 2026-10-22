// Heutiges Datum für den Auftrag (dynamischer, ungecachter Teil). So lassen sich «morgen» oder «nächsten Freitag» richtig berechnen.
const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Das Datum wird in der Zeitzone Europe/Zurich bestimmt. now ist ein Parameter, damit Tests die Uhr festlegen können.
function datumZuerich(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = t => Number(parts.find(p => p.type === t).value);
  const y = get('year'), m = get('month'), d = get('day');
  const wochentag = TAGE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { y, m, d, wochentag, monat: MONATE[m - 1] };
}

function heuteZeile(now = new Date()) {
  const { y, d, wochentag, monat } = datumZuerich(now);
  return `Heute ist ${wochentag}, ${d}. ${monat} ${y} (Zeitzone Europe/Zurich). Relative Datumsangaben (morgen, nächsten Freitag) aus diesem Datum berechnen.`;
}

// Als Block für den dynamischen Teil des Systems
function heuteBlock(now = new Date()) {
  return '\n\n' + heuteZeile(now);
}

module.exports = { heuteZeile, heuteBlock, datumZuerich };
