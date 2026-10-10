// Austauschbare Sync-Schicht für externe Kalender. Jeder Anbieter ist eine Datei in diesem Ordner mit
//   { name, push(ereignis), delete(ereignis) }
// ereignis: { uid, titel, datum, beginn, ende, ganztaegig, typ, notiz }
// Aktiv ist zunächst nur der ICS-Feed (liest live aus der Datenbank, braucht kein Push).
// Für Google oder Outlook kommt eine weitere Datei hinzu und wird hier eingetragen.
const anbieter = [require('./icsFeed')];

async function alle(methode, ereignis) {
  for (const a of anbieter) {
    try { await a[methode](ereignis); } catch (e) { console.error('[kalendersync]', a.name, methode, 'fehlgeschlagen:', e.message); }
  }
}
module.exports = {
  anbieter,
  push: (ereignis) => alle('push', ereignis),
  delete: (ereignis) => alle('delete', ereignis)
};
