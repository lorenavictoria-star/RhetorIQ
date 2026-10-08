// Alle Texte der E-Mails rund um Anfragen aus dem Kontaktformular.
// Diese Datei ist die einzige Stelle, die für den Wortlaut angepasst werden muss.

// Eingangsbestätigung, geht sofort nach dem Absenden des Formulars raus.
function ackText({ name }) {
  return `Guten Tag ${name}\n\nVielen Dank für Ihre Anfrage. Ich habe sie erhalten und melde mich innert 24 Stunden persönlich bei Ihnen.\n\nFreundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch`;
}

// Hinweis an die Beraterin über eine neue Anfrage.
function notifyText({ name, company, email, message }) {
  return `Neue Anfrage über die Webseite.\n\nName: ${name}\nFirma: ${company || '-'}\nE-Mail: ${email}\n\nNachricht:\n${message || '-'}\n\nIn der Plattform unter Kunden die Vorab-E-Mail senden (Du oder Sie wählen).`;
}

// Vorab-E-Mail vor dem Workshop. anrede: 'du' oder 'sie'. titel: 'Frau', 'Herr' oder ''.
function vorabText({ name, anrede, titel, datum }) {
  const teile = name.trim().split(/\s+/);
  const vor = teile[0];
  const nach = teile[teile.length - 1];
  if (anrede === 'du') {
    const gruss = titel === 'Frau' ? `Liebe ${vor}` : titel === 'Herr' ? `Lieber ${vor}` : `Hallo ${vor}`;
    return `${gruss}\n\nIch freue mich auf unseren Workshop «Die Stimme finden» am ${datum}. Damit wir die Zeit gut nutzen, bitte ich dich um drei kleine Vorbereitungen:\n\n1. Bring zwei bis drei eigene Texte mit, die du in letzter Zeit geschrieben hast (E-Mail, Beitrag, Rede). Bitte unverändert.\n2. Überlege dir einen Moment im Beruf, auf den du stolz warst.\n3. Plane ungestörte Zeit ein, ohne Laptop und Telefon.\n\nNach dem Workshop richte ich deine persönliche Plattform ein. Du erhältst dann deinen Zugang per E-Mail.\n\nHerzliche Grüsse\nLorena`;
  }
  const gruss = titel ? `Guten Tag ${titel} ${nach}` : `Guten Tag ${name}`;
  return `${gruss}\n\nIch freue mich auf unseren Workshop «Die Stimme finden» am ${datum}. Damit wir die Zeit gut nutzen, bitte ich Sie um drei kleine Vorbereitungen:\n\n1. Bringen Sie zwei bis drei eigene Texte mit, die Sie in letzter Zeit geschrieben haben (E-Mail, Beitrag, Rede). Bitte unverändert.\n2. Überlegen Sie sich einen Moment im Beruf, auf den Sie stolz waren.\n3. Planen Sie ungestörte Zeit ein, ohne Laptop und Telefon.\n\nNach dem Workshop richte ich Ihre persönliche Plattform ein. Sie erhalten dann Ihren Zugang per E-Mail.\n\nFreundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch`;
}

module.exports = { ackText, notifyText, vorabText };
