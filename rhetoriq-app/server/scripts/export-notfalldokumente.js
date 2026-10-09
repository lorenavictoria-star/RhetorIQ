// Schreibt die Word-Dokumente Notfallkarte und Notfallordner in die angegebenen Ordner.
// Aufruf: node scripts/export-notfalldokumente.js <Ordner> [weiterer Ordner ...]
// Enthält keine Zugangsdaten und braucht keine Datenbank.
const fs = require('fs');
const path = require('path');
const nd = require('../lib/notfalldokumente');

(async () => {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('Bitte mindestens einen Zielordner angeben.'); process.exit(1); }
  const files = [['RhetorIQ_Notfallkarte.docx', await nd.buildNotfallkarte()], ['RhetorIQ_Notfallordner_Vertretung.docx', await nd.buildNotfallordner()]];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    for (const [name, buf] of files) { fs.writeFileSync(path.join(d, name), buf); console.log('geschrieben:', path.join(d, name)); }
  }
})();
