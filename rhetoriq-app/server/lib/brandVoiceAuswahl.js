// Brand Voice in Schichten: Der Kern steht bei jedem Text vollständig im Auftrag, Detailabschnitte nur, wenn sie zur Textart passen.
// Gliederung im Dokument (reiner Text):
//   KERN                              (immer enthalten; alles vor dem ersten Detailabschnitt zählt zum Kern)
//   DETAIL (Textarten: Webseite, LinkedIn): Titel
//   DETAIL: Titel                     (ohne Angabe: immer enthalten)
// Ein Abschnitt reicht bis zur nächsten Zeile, die mit KERN oder DETAIL beginnt. Dokumente ohne diese Gliederung bleiben unverändert.
const { stilmittelRegeln } = require('./lintErlaubt');
const TEXTART = [
  [/webseite|website|web\b/i, 'website'], [/linkedin|social/i, 'linkedin'], [/newsletter/i, 'newsletter'],
  [/mail/i, 'email'], [/presse|medien/i, 'press'], [/rede|auftritt/i, 'speech'], [/brief/i, 'brief']
];
const KOPF = /^\s*(KERN|DETAIL)\b(.*)$/;

function fuerTextart(text, textart) {
  const s = String(text || '');
  if (!textart || !/^\s*(KERN|DETAIL)\b/m.test(s)) return s;
  const zeilen = s.split('\n');
  const aus = [];
  let zeige = true;
  for (const z of zeilen) {
    const k = KOPF.exec(z);
    if (k) {
      if (k[1] === 'KERN') zeige = true;
      else {
        const a = /\(\s*Textarten?\s*:\s*([^)]*)\)/i.exec(k[2]);
        if (!a) zeige = true;
        else {
          const arten = new Set();
          for (const w of a[1].split(/[,/]/)) { const t = (TEXTART.find(([re]) => re.test(w)) || [])[1]; if (t) arten.add(t); }
          zeige = !arten.size || arten.has(textart);
        }
      }
    }
    if (zeige) aus.push(z);
  }
  return aus.join('\n');
}

// Gedankenstriche stehen nie in dem, was die KI als Vorbild liest
function ohneGedankenstriche(text) {
  return String(text || '').split(' — ').join(', ').split(' – ').join(', ').split('—').join('-').split('–').join('-');
}

function fuerAuftrag(text, textart) { return ohneGedankenstriche(fuerTextart(text, textart)); }

module.exports = { fuerTextart, ohneGedankenstriche, fuerAuftrag, stilmittelRegeln };
