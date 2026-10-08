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
    return `${gruss}\n\nVielen Dank für deine Anfrage. Ich freue mich auf unseren Workshop am ${datum}.\n\nWir finden gemeinsam heraus, wie dein Unternehmen wirklich klingt. Daraus entsteht die Stimme, in der RhetorIQ später für dich schreibt.\n\nEine Sache bitte ich dich vorzubereiten: Bring zwei bis drei Texte mit, die du selbst geschrieben hast, zum Beispiel eine E-Mail, einen Beitrag oder eine Rede. Bitte unverändert, so wie sie sind. Daran erkennen wir deine Stimme am besten.\n\nAlles Weitere besprechen wir vor Ort. Bei Fragen antworte einfach auf diese E-Mail.\n\nHerzliche Grüsse\nLorena`;
  }
  const gruss = titel ? `Guten Tag ${titel} ${nach}` : `Guten Tag ${name}`;
  return `${gruss}\n\nVielen Dank für Ihre Anfrage. Ich freue mich auf unseren Workshop am ${datum}.\n\nWir finden gemeinsam heraus, wie Ihr Unternehmen wirklich klingt. Daraus entsteht die Stimme, in der RhetorIQ später für Sie schreibt.\n\nEine Sache bitte ich Sie vorzubereiten: Bringen Sie zwei bis drei Texte mit, die Sie selbst geschrieben haben, zum Beispiel eine E-Mail, einen Beitrag oder eine Rede. Bitte unverändert, so wie sie sind. Daran erkennen wir Ihre Stimme am besten.\n\nAlles Weitere besprechen wir vor Ort. Bei Fragen antworten Sie einfach auf diese E-Mail.\n\nFreundliche Grüsse\nLorena Lienhard`;
}

module.exports = { ackText, notifyText, vorabText };
