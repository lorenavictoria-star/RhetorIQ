// Passwortregel für NEUE Passwörter (Befund F-13): Länge zählt, nicht Komplexität. Bestehende Passwörter bleiben gültig.
const MIN_PASSWORD = 12;
const PASSWORD_HINT = `Bitte mindestens ${MIN_PASSWORD} Zeichen wählen, am besten ein Satz oder mehrere Wörter.`;
const validPassword = (pw) => typeof pw === 'string' && pw.length >= MIN_PASSWORD && pw.length <= 200;
module.exports = { MIN_PASSWORD, PASSWORD_HINT, validPassword };
