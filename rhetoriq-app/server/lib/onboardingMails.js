// Alle Texte der neuen Onboarding-Funktionen an einer Stelle (Du- und Sie-Form).
// Der Wortlaut der Anfrage-Mails liegt weiterhin in lib/inquiryMails.js.

const FRIST_TAGE = 7;

// Einladung mit Zugangslink nach dem Workshop. anrede: 'du' oder 'sie'.
// titel: 'Frau', 'Herr' oder ''. kontakt: vollständiger Name der Ansprechperson.
function einladungMail({ kontakt, anrede, titel, link }) {
  const teile = String(kontakt || '').trim().split(/\s+/).filter(Boolean);
  const vor = teile[0] || '';
  const nach = teile[teile.length - 1] || '';
  if (anrede === 'du') {
    const gruss = titel === 'Herr' ? `Lieber ${vor}` : titel === 'Frau' ? `Liebe ${vor}` : `Hallo ${vor}`;
    return {
      subject: 'Dein Zugang zu RhetorIQ',
      text: `${gruss}\n\nDanke für den Workshop. Deine Plattform ist bereit, mit deiner eigenen Stimme und den Textarten, die wir gemeinsam ausgewählt haben.\n\nMit diesem Link wählst du dein Passwort und meldest dich zum ersten Mal an:\n${link}\n\nDer Link gilt ${FRIST_TAGE} Tage. Wenn du Fragen hast, antworte einfach auf diese E-Mail.\n\nHerzliche Grüsse\nLorena`
    };
  }
  const gruss = titel && nach ? `Guten Tag ${titel} ${nach}` : `Guten Tag ${kontakt || ''}`.trim();
  return {
    subject: 'Ihr Zugang zu RhetorIQ',
    text: `${gruss}\n\nVielen Dank für den Workshop. Ihre Plattform ist bereit, mit Ihrer eigenen Stimme und den Textarten, die wir gemeinsam ausgewählt haben.\n\nMit diesem Link wählen Sie Ihr Passwort und melden sich zum ersten Mal an:\n${link}\n\nDer Link gilt ${FRIST_TAGE} Tage. Bei Fragen antworten Sie einfach auf diese E-Mail.\n\nFreundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch`
  };
}

// Zusatzblock in der Mail an die Beraterin, wenn die Klientin einen Auftrag und/oder eine Frist mitgibt.
function auftragBlock({ instruction, dueAt }) {
  const teile = [];
  if (instruction) teile.push(`Auftrag der Klientin oder des Klienten:\n${instruction}`);
  if (dueAt) {
    const d = new Date(dueAt);
    const stamp = d.toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    teile.push(`Bis spätestens: ${stamp}`);
  }
  return teile.length ? '\n' + teile.join('\n\n') + '\n' : '';
}

// Hinweis im Dateinamen von gesicherten Texten.
function entwurfName(modul, datum) {
  return `${modul || 'Text'} · ${datum}.txt`;
}

module.exports = { einladungMail, auftragBlock, entwurfName, FRIST_TAGE };
