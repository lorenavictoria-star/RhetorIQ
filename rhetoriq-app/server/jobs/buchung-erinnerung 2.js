// Erinnerungsmail am Vortag eines gebuchten Gesprächs, täglich um 16:00 (Europe/Zurich). Abschaltbar mit BUCHUNG_ERINNERUNG=aus.
// Idempotent: jede Buchung wird vor dem Senden reserviert, ein zweiter Lauf am selben Tag sendet nichts mehr.
const BD = require('../lib/buchungDaten');

async function runBuchungErinnerungJob(opts = {}) {
  if (String(process.env.BUCHUNG_ERINNERUNG || '').toLowerCase() === 'aus') { console.log('[buchung] Erinnerung abgeschaltet (BUCHUNG_ERINNERUNG=aus)'); return { status: 'aus' }; }
  const r = await BD.erinnerungenSenden({ jetzt: opts.jetzt || new Date() });
  if (r.gesendet) console.log(`[buchung] ${r.gesendet} Erinnerung(en) gesendet`);
  return r;
}

module.exports = { runBuchungErinnerungJob };
