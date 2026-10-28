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

const TAGE_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONATE_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function heuteZeile(now = new Date(), sprache) {
  const { y, m, d, wochentag, monat } = datumZuerich(now);
  if (sprache === 'en') {
    const wd = TAGE_EN[TAGE.indexOf(wochentag)];
    return `Today is ${wd}, ${d} ${MONATE_EN[m - 1]} ${y} (time zone Europe/Zurich). Work out relative dates (tomorrow, next Friday) from this date.`;
  }
  return `Heute ist ${wochentag}, ${d}. ${monat} ${y} (Zeitzone Europe/Zurich). Relative Datumsangaben (morgen, nächsten Freitag) aus diesem Datum berechnen.`;
}

// Als Block für den dynamischen Teil des Systems
function heuteBlock(now = new Date(), sprache) {
  return '\n\n' + heuteZeile(now, sprache);
}

module.exports = { heuteZeile, heuteBlock, datumZuerich };
