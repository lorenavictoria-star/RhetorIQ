// Geschützte Speicherung: Was der Daten-Wächter nicht an die KI schickt, liegt auch nicht im Klartext in der Datenbank.
// Gilt, wenn der Daten-Wächter im Modus «ersetzen» oder «sperren» läuft (oder der einzelne Aufruf «Ersetzen und senden»
// gewählt hat). Die Nutzerin sieht den Text während der Sitzung wie gewohnt; gespeichert wird die Fassung mit Platzhaltern
// wie [IBAN-1]. Mehrere Werte eines Aufrufs (Eingabe und Ergebnis) teilen sich ein Abbild, gleiche Werte erhalten also
// denselben Platzhalter. Das Abbild lebt nur in diesem Aufruf und wird nie gespeichert.
const dw = require('./datenwaechter');
const store = require('./datenwaechterStore');

async function einstellungenFallsAktiv() {
  const e = await store.holeEinstellungen();
  let ctx = {};
  try { ctx = require('./meter').context() || {}; } catch { ctx = {}; }
  if (e.modus === 'ersetzen' || e.modus === 'sperren') return e;
  if (e.modus === 'warnen' && ctx.dwErsetzen === true) return e;
  return null;
}

function tief(wert, f) {
  if (typeof wert === 'string') return f(wert);
  if (Array.isArray(wert)) return wert.map(w => tief(w, f));
  if (wert && typeof wert === 'object' && Object.getPrototypeOf(wert) === Object.prototype) {
    const aus = {};
    for (const k of Object.keys(wert)) aus[k] = tief(wert[k], f);
    return aus;
  }
  return wert;
}

// schuetzeAlle(a, b, ...) -> [a', b', ...]  (Strings, Arrays und einfache Objekte werden durchlaufen)
// Ein Fehler hier darf das Speichern nie verhindern: dann bleibt der Wert unverändert und der Fehler steht im Log.
async function schuetzeAlle(...werte) {
  try {
    const e = await einstellungenFallsAktiv();
    if (!e) return werte;
    const abbild = dw.neuesAbbild();
    const f = (s) => dw.schuetze(s, 'ersetzen', { typen: e.typen, abbild }).text;
    return werte.map(w => tief(w, f));
  } catch (err) {
    console.error('[speicherSchutz] übersprungen:', err && err.code ? err.code : 'Fehler');
    return werte;
  }
}

module.exports = { schuetzeAlle, tief };
