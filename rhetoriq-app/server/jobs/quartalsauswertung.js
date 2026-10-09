// Quartalsauswertung: am 2. Januar, April, Juli und Oktober um 07:00 (Europe/Zurich) für alle berechtigten Klienten
// (Business, Enterprise, Zusatz «Quartalsreview»). Abschaltbar mit QUARTALSAUSWERTUNG=aus.
// Erreicht das Tagesbudget (lib/budget.js) die Grenze, endet der Lauf sauber: die übrigen Klienten bleiben offen und
// können am nächsten Tag mit dem Knopf bei der Beraterin nachgeholt werden (ein Klient wird nie doppelt ausgewertet).
const qa = require('../lib/quartalsauswertung');

async function runQuartalsauswertungJob(opts = {}) {
  if (String(process.env.QUARTALSAUSWERTUNG || '').toLowerCase() === 'aus') { console.log('[quartalsreview] abgeschaltet (QUARTALSAUSWERTUNG=aus)'); return []; }
  const budget = require('../lib/budget');
  const liste = await qa.berechtigte();
  const out = [];
  for (let i = 0; i < liste.length; i++) {
    const c = liste[i];
    if (!(await budget.allow('quartalsreview')).ok) {
      for (const rest of liste.slice(i)) out.push({ clientId: rest.id, status: 'uebersprungen', grund: 'Tagesbudget erreicht.' });
      break;
    }
    try { out.push({ clientId: c.id, ...(await qa.runForClient(c.id, opts)) }); }
    catch (e) { console.error('[quartalsreview] Klient', c.id, e.message); out.push({ clientId: c.id, status: 'fehler' }); }
  }
  console.log(`[quartalsreview] ${out.filter(x => x.status === 'fertig').length} von ${liste.length} Auswertungen erstellt`);
  return out;
}

module.exports = { runQuartalsauswertungJob };
