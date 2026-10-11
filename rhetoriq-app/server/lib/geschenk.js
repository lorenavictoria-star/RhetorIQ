// Die zwei Geschenk-PDFs. Sie liegen unter server/assets/geschenke und werden nie als statische Dateien ausgeliefert,
// sondern nur als Mail-Anhang verschickt (derselbe Weg wie die Kalenderdatei der Terminbuchung: attachments mit base64 über die Outbox).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'geschenke');
const GESCHENKE = {
  prompt: { key: 'prompt', titel: 'Stimm-Prompt', datei: 'RhetorIQ_Stimm_Prompt.pdf', source: 'geschenk-prompt' },
  leitfaden: { key: 'leitfaden', titel: 'KI-Leitfaden', datei: 'RhetorIQ_KI_Leitfaden.pdf', source: 'geschenk-leitfaden' }
};
const MAX_BYTES = 5 * 1024 * 1024; // Brevo erlaubt deutlich mehr, in der Warteschlange soll der Anhang aber klein bleiben

function finde(key) { return Object.prototype.hasOwnProperty.call(GESCHENKE, key) ? GESCHENKE[key] : null; }
function anhang(g) {
  const buf = fs.readFileSync(path.join(DIR, g.datei));
  if (buf.length > MAX_BYTES) throw new Error('Geschenk-PDF ist zu gross: ' + g.datei);
  return [{ name: g.datei, contentBase64: buf.toString('base64') }];
}
module.exports = { DIR, GESCHENKE, finde, anhang, MAX_BYTES };
