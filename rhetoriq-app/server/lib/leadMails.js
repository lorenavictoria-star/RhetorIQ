// Mails für Warteliste und Geschenke. Interessenten werden gesiezt, Lorena wird geduzt.
// Eingaben erscheinen nur als Text, Zeilenumbrüche sind aus Namen und Betreffzeilen entfernt.
const { safeName } = require('./inquiryMails');
const { einZeile, mehrzeilig } = require('./buchung');

const betreff = (t) => einZeile(t, 150);
const gruss = (name) => { const n = safeName(name); return n ? 'Guten Tag ' + n : 'Guten Tag'; };
const SCHLUSS = 'Freundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch';
const SCHLUSS_HERZLICH = 'Herzlich\nLorena Lienhard';

function wartelisteBestaetigung(e) {
  const text = `${gruss(e.name)}\n\nDanke für Ihre Anmeldung. Ich habe sie eben gelesen und Ihren Platz notiert. Spätestens morgen schreibe ich Ihnen persönlich, und wir hören zusammen, was Sie sich von RhetorIQ wünschen.\n\nFalls es bis dahin etwas gibt, das ich wissen sollte, antworten Sie einfach auf diese Mail. Sie landet direkt bei mir.\n\n${SCHLUSS_HERZLICH}`;
  return { subject: 'Ihr Platz bei RhetorIQ', text };
}
function wartelisteHinweis(e) {
  const text = `Neuer Eintrag auf der Warteliste.\n\nName: ${einZeile(e.name, 80)}\nE-Mail: ${e.email}\nUnternehmen: ${einZeile(e.unternehmen, 100)}\nBranche: ${einZeile(e.branche, 80)}\n\nAnliegen:\n${mehrzeilig(e.anliegen, 1000) || '-'}\n\nDie Einwilligung liegt vor. Du findest den Eintrag unter Warteliste in der Plattform und kannst dort zum Gespräch einladen.`;
  return { subject: betreff(`Neu auf der Warteliste: ${einZeile(e.unternehmen, 60)}`), text };
}
function wartelisteEinladung(e, { terminUrl }) {
  const text = `${gruss(e.name)}\n\nIch freue mich, Sie zu einem persönlichen Gespräch einzuladen. Wir klären in zwanzig Minuten, wie RhetorIQ zu Ihrem Unternehmen passt und wie der Einstieg aussieht.\n\nIhre Zeit wählen Sie hier:\n${terminUrl}\n\nWenn die Zeiten nicht passen, antworten Sie einfach auf diese Mail.\n\n${SCHLUSS}`;
  return { subject: 'Einladung zum Gespräch bei RhetorIQ', text };
}

function geschenkMail(name, g, { terminUrl, schnelltestUrl }) {
  const text = `${gruss(name)}\n\nVielen Dank für Ihr Interesse. Das gewünschte Geschenk finden Sie als PDF im Anhang: ${g.titel}.\n\nWenn Sie wissen möchten, wie Ihre Firmenstimme klingt, machen Sie den Stimm-Schnelltest:\n${schnelltestUrl}\n\nWenn Sie das Thema im Gespräch vertiefen möchten, wählen Sie hier ein 20-Minuten-Gespräch:\n${terminUrl}\n\nIch freue mich, wenn Ihnen das PDF nützt.\n\n${SCHLUSS}`;
  return { subject: betreff(`Ihr Geschenk von RhetorIQ: ${g.titel}`), text };
}
function geschenkHinweis({ name, email }, g) {
  const text = `Neuer Lead über das Geschenk-Formular.\n\nName: ${einZeile(name, 80)}\nE-Mail: ${email}\nGewähltes Geschenk: ${g.titel}\n\nDie Einwilligung zur Datenschutzerklärung und zur Kontaktaufnahme liegt vor. Das PDF ist an die Person unterwegs. Der Lead steht unter Anfragen in der Plattform.`;
  return { subject: betreff(`Geschenk angefordert: ${g.titel}, ${einZeile(name, 60)}`), text };
}

module.exports = { wartelisteBestaetigung, wartelisteHinweis, wartelisteEinladung, geschenkMail, geschenkHinweis };
