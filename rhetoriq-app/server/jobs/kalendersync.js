// Kalender-Synchronisation, alle 15 Minuten (abschaltbar mit KALENDERSYNC=aus):
//  1. fremde Kalender (iCloud, Outlook) neu lesen
//  2. Google: Kanal vor Ablauf erneuern (Kanäle laufen höchstens 7 Tage), danach Sicherheitsnetz-Abgleich, falls ein Webhook ausgefallen ist
const KD = require('../lib/kalendersync/daten');
const F = require('../lib/kalendersync/fremd');
const google = require('../lib/kalendersync/google');
const { sauber } = require('../lib/kalendersync/googleApi');

async function runKalendersyncJob() {
  if (String(process.env.KALENDERSYNC || '').toLowerCase() === 'aus') return { status: 'aus' };
  await KD.ensureSchema();
  const r = { fremd: 0, google: 0, kanaele: 0, fehler: 0 };
  try { r.fremd = (await F.alleAktualisieren()).geaendert; } catch { r.fehler++; console.error('[kalendersync] fremde Kalender fehlgeschlagen'); }
  for (const row of await KD.googleAlle()) {
    if (!row.calendar_id) continue;
    try {
      const k = await google.kanalSicherstellen(row.advisor_id);
      if (k.erneuert) r.kanaele++;
    } catch (e) { r.fehler++; console.error('[kalendersync] Kanal fehlgeschlagen:', sauber(e.message)); }
    const s = await google.synchronisiere(row.advisor_id, { kanal: false });
    if (s.ok) r.google++; else r.fehler++;
  }
  return { status: 'ok', ...r };
}

module.exports = { runKalendersyncJob };
