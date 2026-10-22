// Gemeinsame Bausteine gegen Missbrauch bei öffentlichen Formularen (Warteliste, Geschenke).
// Das Muster stammt aus der Terminbuchung: Absenderprüfung, kleine Zählung je Schlüssel im Speicher, Zeitfenster-Ticket.
const ALLOWED_ORIGINS = ['https://rhetoriq.ch', 'https://www.rhetoriq.ch'];
const MIN_ALTER_MS = 4000;          // Menschen brauchen mehr als 4 Sekunden von der Anzeige bis zum Absenden
const MAX_ALTER_MS = 6 * 3600000;   // ältere Seiten bitte neu laden

function zaehler(max, fensterMs) {
  const m = new Map();
  return {
    erlaubt(key, jetzt = Date.now()) {
      if (m.size > 5000) for (const [k, v] of m) if (!v.length || jetzt - v[v.length - 1] > fensterMs) m.delete(k);
      const liste = (m.get(key) || []).filter(t => jetzt - t < fensterMs);
      if (liste.length >= max) { m.set(key, liste); return false; }
      liste.push(jetzt); m.set(key, liste); return true;
    },
    leeren() { m.clear(); }
  };
}
function erlaubteHerkunft() {
  const l = ALLOWED_ORIGINS.slice();
  try { if (process.env.APP_URL) l.push(new URL(process.env.APP_URL).origin); } catch {}
  return l;
}
function vonUnsererSeite(req) {
  const origin = String(req.headers.origin || req.headers.referer || '');
  return erlaubteHerkunft().some(o => origin === o || origin.startsWith(o + '/'));
}
// Name: einzeilig, 2 bis 80 Zeichen, keine Links oder Spitzklammern. Liefert den bereinigten Namen oder null.
function pruefeName(roh, einZeile) {
  const name = einZeile(roh, 200);
  if (name.length < 2 || name.length > 80 || /https?:|www\.|@|[<>]/i.test(name)) return null;
  return name;
}
module.exports = { zaehler, vonUnsererSeite, erlaubteHerkunft, pruefeName, MIN_ALTER_MS, MAX_ALTER_MS };
