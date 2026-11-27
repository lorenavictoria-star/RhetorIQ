// Holt alle 15 Minuten neue Bewertungen der verbundenen Kanäle und schreibt Entwürfe (oder veröffentlicht im Auto-Modus).
// Abschaltbar mit BEWERTUNGEN_JOB=aus. Ein Kunde mit Fehler hält die anderen nicht auf.
const B = require('../lib/bewertungen');
let laeuft = false;

async function runBewertungenJob() {
  if (String(process.env.BEWERTUNGEN_JOB || '').toLowerCase() === 'aus') return { uebersprungen: true };
  if (laeuft) return { uebersprungen: true };
  laeuft = true;
  const sum = { kunden: 0, neu: 0, fehler: 0 };
  try {
    for (const id of await B.alleKunden()) {
      try { const r = await B.abholenUndVerarbeiten(id); sum.kunden++; sum.neu += r.neu; sum.fehler += r.fehler; }
      catch (e) { sum.fehler++; console.error('[bewertungen] Kunde', id, e.message); }
    }
  } finally { laeuft = false; }
  if (sum.neu) console.log(`[bewertungen] ${sum.neu} neue Bewertung(en) bei ${sum.kunden} Kunde(n)`);
  return sum;
}
module.exports = { runBewertungenJob };
