// Link «Jetzt an den Kunden senden» in der Hinweis-Mail an Lorena: ein Klick genügt, ohne Anmeldung.
// Der Link ist mit dem Geheimnis der Plattform unterschrieben, gilt für genau einen Test und eine Anrede (sie oder du) und läuft nach 14 Tagen ab.
// Aufrufe mit GET zeigen nur eine Vorschau. Gesendet wird erst mit dem Knopf auf dieser Seite (POST), damit Mail-Prüfprogramme nichts auslösen.
const crypto = require('crypto');
const TAGE = 14;
const appUrl = () => (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const sig = (id, anrede, exp) => crypto.createHmac('sha256', String(process.env.JWT_SECRET || '') + ':schnelltest-senden').update(`${id}.${anrede}.${exp}`).digest('hex').slice(0, 40);

function erzeugeLink(id, anrede, jetzt = Date.now()) {
  const a = anrede === 'du' ? 'du' : 'sie', exp = jetzt + TAGE * 86400000;
  return `${appUrl()}/api/schnelltest-senden/${encodeURIComponent(id)}?a=${a}&e=${exp}&t=${sig(id, a, exp)}`;
}
function pruefe(id, a, e, t, jetzt = Date.now()) {
  const anrede = a === 'du' ? 'du' : 'sie', exp = Number(e);
  if (!Number.isFinite(exp) || exp < jetzt) return { ok: false, grund: 'abgelaufen' };
  const soll = Buffer.from(sig(id, anrede, exp)), ist = Buffer.from(String(t || ''));
  if (soll.length !== ist.length || !crypto.timingSafeEqual(soll, ist)) return { ok: false, grund: 'ungueltig' };
  return { ok: true, anrede, exp };
}
module.exports = { erzeugeLink, pruefe, TAGE };
