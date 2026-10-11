// Alle Texte der Mails rund um die Terminbuchung. Interessenten werden gesiezt, Lorena wird geduzt.
// Eingaben werden als Text eingesetzt: Zeilenumbrüche und Steuerzeichen sind aus Namen und Betreffzeilen entfernt (keine Kopfzeilen-Injektion).
const Z = require('./zeit');
const { safeName } = require('./inquiryMails');
const { einZeile, mehrzeilig } = require('./buchung');

const betreff = (t) => einZeile(t, 150);
const gruss = (name) => { const n = safeName(name); return n ? 'Guten Tag ' + n : 'Guten Tag'; };
const SCHLUSS = 'Freundliche Grüsse\nLorena Lienhard\ncontact@lorenalienhard.ch';

function wann(b) {
  return { tag: Z.datumMitJahr(b.datum), zeit: `${Z.hhmm(b.beginn)} bis ${Z.hhmm(b.ende)} Uhr (Schweizer Zeit)`, dauer: `${b.ende - b.beginn} Minuten`,
    kurz: `${Z.datumLang(b.datum)}, ${Z.hhmm(b.beginn)} Uhr` };
}
function kontaktBlock(s) {
  const t = [einZeile(s && s.kontakt_text, 300)];
  if (s && s.kontakt_link) t.push('Videolink: ' + s.kontakt_link);
  return t.filter(Boolean).join('\n');
}

// Bestätigung an den Interessenten. art: 'neu' oder 'verschoben'
function bestaetigung(b, s, { verwaltenUrl, art = 'neu' } = {}) {
  const w = wann(b);
  const kopf = art === 'verschoben' ? 'Ihr Gespräch ist verschoben. Der neue Termin:' : 'Vielen Dank für Ihre Buchung. Ihr Gespräch ist bestätigt:';
  const text = `${gruss(b.name)}\n\n${kopf}\n\nDatum: ${w.tag}\nUhrzeit: ${w.zeit}\nDauer: ${w.dauer}\n\n${kontaktBlock(s)}\n\nDen Kalendereintrag finden Sie als Datei im Anhang. Öffnen Sie ihn, damit der Termin in Ihrem Kalender steht.\n\nFalls etwas dazwischenkommt, können Sie den Termin hier absagen oder verschieben:\n${verwaltenUrl}\n\n${SCHLUSS}`;
  return { subject: betreff(art === 'verschoben' ? `Ihr Gespräch wurde verschoben: ${w.kurz}` : `Ihr Gespräch am ${w.kurz}`), text };
}

// Hinweis an Lorena
function hinweisBeraterin(b, { art = 'neu', alt = null } = {}) {
  const w = wann(b);
  const kopf = art === 'verschoben' ? `${einZeile(b.name, 80)} hat den Termin verschoben.` : 'Neue Terminbuchung über die Webseite.';
  const altZeile = alt ? `Bisher: ${wann(alt).kurz}\n` : '';
  const text = `${kopf}\n\n${altZeile}Termin: ${w.tag}, ${w.zeit}\nDauer: ${w.dauer}\n\nName: ${einZeile(b.name, 80)}\nE-Mail: ${b.email}\n\nAnliegen:\n${mehrzeilig(b.anliegen, 1500) || '-'}\n\nDer Termin steht als Kundentermin in deinem Kalender. Die Anfrage findest du unter Anfragen in der Plattform.`;
  return { subject: betreff(art === 'verschoben' ? `Termin verschoben: ${einZeile(b.name, 60)}, ${w.kurz}` : `Neue Buchung: ${einZeile(b.name, 60)}, ${w.kurz}`), text };
}

// Absage. von: 'interessent' oder 'beraterin'
function absageInteressent(b, { neuUrl, von = 'interessent' } = {}) {
  const w = wann(b);
  const kern = von === 'beraterin'
    ? `Leider muss ich unser Gespräch am ${w.kurz} absagen. Das tut mir leid.`
    : `Ihr Gespräch am ${w.kurz} ist abgesagt. Die Zeit ist wieder frei.`;
  const text = `${gruss(b.name)}\n\n${kern}\n\nEinen neuen Termin können Sie jederzeit hier wählen:\n${neuUrl}\n\n${SCHLUSS}`;
  return { subject: betreff(`Gespräch abgesagt: ${w.kurz}`), text };
}
function absageBeraterin(b, { von = 'interessent' } = {}) {
  const w = wann(b);
  const kern = von === 'beraterin' ? `Du hast den Termin mit ${einZeile(b.name, 80)} abgesagt.` : `${einZeile(b.name, 80)} hat den Termin abgesagt.`;
  const text = `${kern}\n\nTermin: ${w.tag}, ${w.zeit}\nE-Mail: ${b.email}\n\nDer Eintrag ist aus deinem Kalender gelöscht, die Zeit ist wieder buchbar.`;
  return { subject: betreff(`Termin abgesagt: ${einZeile(b.name, 60)}, ${w.kurz}`), text };
}

// Erinnerung am Vortag
function erinnerung(b, s) {
  const w = wann(b);
  const text = `${gruss(b.name)}\n\nZur Erinnerung: Morgen um ${Z.hhmm(b.beginn)} Uhr (Schweizer Zeit) findet unser Gespräch statt, es dauert ${w.dauer}.\n\n${kontaktBlock(s)}\n\nFalls Sie den Termin nicht wahrnehmen können, sagen Sie ihn bitte über den Link in der Bestätigungsmail ab oder verschieben ihn dort.\n\n${SCHLUSS}`;
  return { subject: betreff(`Erinnerung: Ihr Gespräch morgen um ${Z.hhmm(b.beginn)} Uhr`), text };
}

// Sofortige Antwort auf das Nachrichtenformular
function formularBestaetigung({ name, email, message }) {
  const kopie = mehrzeilig(message, 1500);
  const text = `${gruss(name)}\n\nDanke für Ihre Anfrage. Ich melde mich innert eines Werktags persönlich bei Ihnen.\n\nIhre Angaben zur Kontrolle:\nName: ${safeName(name) || '-'}\nE-Mail: ${email}\nNachricht:\n${kopie || '-'}\n\n${SCHLUSS}`;
  return { subject: 'Ihre Anfrage bei RhetorIQ', text };
}

module.exports = { bestaetigung, hinweisBeraterin, absageInteressent, absageBeraterin, erinnerung, formularBestaetigung, wann, betreff };
