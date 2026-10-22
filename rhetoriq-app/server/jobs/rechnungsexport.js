// Am 1. jedes Monats: Rechnungen und Zahlungseingänge des Vormonats als ZIP per E-Mail an die Beraterin (lib/rechnungExport.js).
const { sendeMonatsablage } = require('../lib/rechnungExport');
async function runRechnungsexport() {
  const r = await sendeMonatsablage();
  if (r.gesendet) console.log(`[rechnungsexport] ${r.ym}: ${r.ausgestellt} Rechnungen, ${r.bezahlt} Zahlungen`);
  return r;
}
module.exports = { runRechnungsexport };
