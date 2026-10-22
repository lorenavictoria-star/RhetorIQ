// Daten-Wächter an der KI-Schnittstelle: bereitet die Optionen eines KI-Aufrufs vor (lib/aiProvider.js ruft das auf).
// Gelesen werden alle Nachrichten (Text und Dokumente, die als Text mitgehen). Fundwerte tauchen nirgends in Logs,
// Fehlermeldungen oder der Datenbank auf; das Abbild lebt nur in diesem Aufruf.
const dw = require('./datenwaechter');

function sperrFehler(typen, funde) {
  const labels = typen.map(t => dw.TYPEN[t].label).join(', ');
  const e = new Error(`Der Daten-Wächter hat sensible Angaben erkannt (${labels}). Der Text wurde nicht an die KI gesendet.`);
  e.status = 422;
  e.datenwaechter = { typen: typen.slice() };
  Object.defineProperty(e, '_funde', { value: funde || [], enumerable: false });   // nur für das Protokoll (Typ und Anzahl)
  return e;
}

function systemMitHinweis(system) {
  const s = typeof system === 'function' ? system({}) : system;
  if (Array.isArray(s)) return [...s, { type: 'text', text: dw.SYSTEM_HINWEIS }];
  if (s === undefined || s === null || s === '') return dw.SYSTEM_HINWEIS;
  return String(s) + '\n\n' + dw.SYSTEM_HINWEIS;
}

// bereiteVor(opts, { einstellungen, kontext }) -> { opts, abbild, modus, funde }
// Wirft bei Modus «sperren» einen Fehler mit status 422 und e.datenwaechter.typen (nur Typen, keine Werte).
function bereiteVor(opts, { einstellungen, kontext = {} } = {}) {
  if (!opts || opts.datenwaechter === false || !Array.isArray(opts.messages)) return { opts, abbild: null, modus: 'aus', funde: [] };
  let modus = einstellungen.modus;
  // Ein einzelner Aufruf darf von «warnen» auf «ersetzen» verschärft werden (Wahl «Ersetzen und senden»), nie umgekehrt
  if (modus === 'warnen' && kontext.dwErsetzen === true) modus = 'ersetzen';
  // Hintergrundaufträge ohne angemeldete Person können niemanden warnen: «sperren» gilt dort als «ersetzen»
  const hatNutzer = !!(kontext.advisorId || kontext.clientId);
  if (modus === 'sperren' && !hatNutzer) modus = 'ersetzen';
  if (modus === 'aus') return { opts, abbild: null, modus, funde: [] };

  const abbild = dw.neuesAbbild();
  const alle = [];
  const fundeHinterlegt = [];
  const wende = (s) => {
    const r = dw.schuetze(s, modus, { typen: einstellungen.typen, abbild });
    alle.push(...r.funde);
    return r.text;
  };
  // Hinterlegtes (Brand Voice, Referenzen, Gedächtnis) steht in den Systemanweisungen. Es wird zuerst bearbeitet (stabile Platzhalter
  // für den Zwischenspeicher) und bei «ersetzen» und «sperren» ersetzt. Gesperrt wird dort nie: Der Nutzer kann hinterlegte Texte nicht im Moment ändern.
  const wendeHinterlegt = (s) => {
    const r = dw.schuetze(s, 'ersetzen', { typen: einstellungen.typen, abbild });
    fundeHinterlegt.push(...r.funde);
    return r.text;
  };
  let system = opts.system;
  if (modus === 'ersetzen' || modus === 'sperren') {
    const sys = typeof system === 'function' ? system({}) : system;
    if (typeof sys === 'string') system = wendeHinterlegt(sys);
    else if (Array.isArray(sys)) system = sys.map(b => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') ? { ...b, text: wendeHinterlegt(b.text) } : b);
    else system = sys;
  }
  const messages = opts.messages.map((m) => {
    if (!m) return m;
    if (typeof m.content === 'string') return { ...m, content: wende(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((b) => {
          if (!b || typeof b !== 'object') return b;
          if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: wende(b.text) };
          if (b.type === 'document' && b.source && b.source.type === 'text' && typeof b.source.data === 'string') return { ...b, source: { ...b.source, data: wende(b.source.data) } };
          return b;
        })
      };
    }
    return m;
  });
  if (modus === 'sperren' && alle.length) throw sperrFehler([...new Set(alle.map(f => f.typ))], alle);
  if ((modus === 'ersetzen' || modus === 'sperren') && (alle.length || fundeHinterlegt.length)) {
    return { opts: { ...opts, messages, system: systemMitHinweis(system) }, abbild, modus, funde: alle.concat(fundeHinterlegt) };
  }
  return { opts, abbild: null, modus, funde: alle };
}

module.exports = { bereiteVor, sperrFehler };
