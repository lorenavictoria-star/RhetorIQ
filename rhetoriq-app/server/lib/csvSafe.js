// CSV-Zelle sicher ausgeben (Befund F-20): Zellen, die mit = + - @ oder Tab beginnen, würde Excel als Formel ausführen.
// Ein vorangestelltes Hochkomma macht daraus gewöhnlichen Text.
function csvCell(v) {
  let t = (v == null ? '' : String(v)).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
}
module.exports = { csvCell };
