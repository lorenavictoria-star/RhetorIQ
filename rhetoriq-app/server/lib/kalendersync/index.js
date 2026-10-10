// Austauschbare Sync-Schicht für externe Kalender. Jeder Anbieter ist eine Datei in diesem Ordner mit
//   { name, push(ereignis), delete(ereignis) }
// ereignis: { advisorId, id, uid, titel, datum, beginn, ende, ganztaegig, typ, notiz, wiederholung, wochentage, bis }
// Aktiv sind der ICS-Feed (liest live aus der Datenbank, braucht kein Push) und Google Kalender (schreibt gebündelt und liest zurück).
// Fremde Kalender (iCloud, Outlook) werden nur gelesen (fremd.js) und gehören nicht in diese Liste.
const { scrubText } = require('../scrub');
const anbieter = [require('./icsFeed'), require('./google')];

async function alle(methode, ereignis) {
  for (const a of anbieter) {
    try { await a[methode](ereignis); } catch (e) { console.error('[kalendersync]', a.name, methode, 'fehlgeschlagen:', scrubText(e.message)); }
  }
}
module.exports = {
  anbieter,
  push: (ereignis) => alle('push', ereignis),
  delete: (ereignis) => alle('delete', ereignis)
};
