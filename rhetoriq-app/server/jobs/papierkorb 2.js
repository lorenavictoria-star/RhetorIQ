// Täglich: Klienten, die seit mehr als 30 Tagen im Papierkorb liegen, endgültig löschen (vollständige Löschroutine).
const { endgueltigNachFrist } = require('../lib/papierkorb');

async function runPapierkorb() {
  const n = await endgueltigNachFrist();
  console.log(`[papierkorb] endgültig gelöscht: ${n}`);
  return n;
}
module.exports = { runPapierkorb };
