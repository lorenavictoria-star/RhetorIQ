// Monatserinnerung (am 1. um 09:00): Mail an Lorena OHNE Anhang mit Link zur Seite Nutzung. Keine KI.
// Die Stimmenmappen enthalten Klientendaten und gehören deshalb nicht in eine Mail.
const { queueEmail } = require('../lib/emailOutbox');

const NOTIFY = () => process.env.ADVISOR_EMAIL || 'contact@lorenalienhard.ch';
const APP = () => (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, '');

async function runErinnerung() {
  const link = `${APP()}/index.html`;
  await queueEmail({
    kind: 'stimmenmappe-erinnerung',
    to: NOTIFY(),
    subject: 'RhetorIQ: Zeit für den Monatsexport der Stimmenmappen',
    text: `Hallo Lorena\n\nZeit für den Monatsexport der Stimmenmappen. Melde dich an, öffne im Menü die Seite Nutzung und lade mit einem Klick alle Stimmenmappen als ZIP herunter:\n${link}\n\nLege die Datei ausserhalb von RhetorIQ ab, zum Beispiel im verschlüsselten Ordner deines Notfallordners. Die Mail enthält bewusst keinen Anhang, weil die Mappen Klientendaten enthalten.\n\nRhetorIQ`
  });
  return { ok: true };
}

module.exports = { runErinnerung };
