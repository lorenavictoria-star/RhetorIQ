// Täglich: neue Rechnungen vor Ablauf der bezahlten Zeit, Zahlungserinnerungen (lib/rechnungAuto.js).
const { taeglich } = require('../lib/rechnungAuto');
async function runRechnungen() {
  const r = await taeglich();
  if (r.neu.length || r.erinnerungen.length) console.log(`[rechnungen] neu: ${r.neu.length}, Erinnerungen: ${r.erinnerungen.length}`);
  return r;
}
module.exports = { runRechnungen };
