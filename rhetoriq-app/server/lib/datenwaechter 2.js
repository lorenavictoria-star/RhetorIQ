// Daten-Wächter: erkennt sensible Angaben in Texten und schützt sie, bevor ein Text an den KI-Anbieter geht.
// Reine Funktionen ohne Datenbank und ohne externe Aufrufe. Fundwerte verlassen diese Datei nur als Rückgabewert an den
// Aufrufer; sie werden hier nie geloggt. Das Abbild (Platzhalter zu Wert) lebt nur im Arbeitsspeicher der laufenden Anfrage.

// Typen mit Anzeigename, Schwere und Platzhalter-Bezeichnung
const TYPEN = {
  AHV: { label: 'AHV-Nummer', schwere: 'hoch', platz: 'AHV' },
  IBAN: { label: 'IBAN', schwere: 'hoch', platz: 'IBAN' },
  KREDITKARTE: { label: 'Kreditkartennummer', schwere: 'hoch', platz: 'KARTE' },
  SCHLUESSEL: { label: 'Passwort oder Schlüssel', schwere: 'hoch', platz: 'SCHLUESSEL' },
  EMAIL: { label: 'E-Mail-Adresse', schwere: 'mittel', platz: 'E-MAIL' },
  TELEFON: { label: 'Telefonnummer', schwere: 'mittel', platz: 'TELEFON' },
  GEBURTSDATUM: { label: 'Geburtsdatum', schwere: 'mittel', platz: 'GEBURTSDATUM' },
  UID: { label: 'UID oder MWST-Nummer', schwere: 'niedrig', platz: 'UID' },
  NAME: { label: 'Name', schwere: 'niedrig', platz: 'NAME' }
};
const ALLE_TYPEN = Object.keys(TYPEN);
// Vorgabe: alle ausser Name (Namen lassen sich nur grob erkennen und würden viele Texte unnötig verändern)
const STANDARD_TYPEN = ALLE_TYPEN.filter(t => t !== 'NAME');
const SCHWERE_RANG = { hoch: 3, mittel: 2, niedrig: 1 };

// ── Prüfziffern ─────────────────────────────────────────────────────────────
function ean13Ok(d) {
  if (!/^\d{13}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (s % 10)) % 10 === Number(d[12]);
}
function luhnOk(d) {
  if (!/^\d{13,19}$/.test(d)) return false;
  let s = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    s += n; dbl = !dbl;
  }
  return s % 10 === 0;
}
function mod97(iban) {
  const t = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of t) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}
function uidOk(digits) {
  if (!/^\d{9}$/.test(digits)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4];
  let s = 0;
  for (let i = 0; i < 8; i++) s += Number(digits[i]) * w[i];
  let p = 11 - (s % 11);
  if (p === 11) p = 0;
  if (p === 10) return false;
  return p === Number(digits[8]);
}
const VORWAHLEN = new Set(['21', '22', '24', '26', '27', '31', '32', '33', '34', '41', '43', '44', '52', '55', '56', '58', '61', '62', '71', '75', '76', '77', '78', '79', '81', '91']);

// ── Muster ──────────────────────────────────────────────────────────────────
// Jede Regel liefert Kandidaten {start, ende, norm} (norm = Schlüssel, damit gleiche Werte denselben Platzhalter bekommen).
const MONATE = '(?:Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)';

function regeln() {
  return {
    SCHLUESSEL(text, out) {
      const feste = [
        /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
        /\bsk-[A-Za-z0-9]{24,}/g,
        /\b(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
        /\bAKIA[0-9A-Z]{16}\b/g,
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
      ];
      for (const re of feste) for (const m of text.matchAll(re)) out.push({ start: m.index, ende: m.index + m[0].length, norm: m[0] });
      for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g)) {
        const s = m.index + m[0].length - m[1].length;
        out.push({ start: s, ende: s + m[1].length, norm: m[1] });
      }
      for (const m of text.matchAll(/\b(?:Passwort|Kennwort|Password|Passwd|Pwd|Zugangscode|Passphrase)\s*(?:ist|lautet)?\s*[:=]\s*(\S+)/gi)) {
        const w = m[1].replace(/[.,;)]+$/, '');
        if (w.length < 3 || /^[*•x]+$/i.test(w) || /^\[.*\]$/.test(w) || /^<.*>$/.test(w)) continue;
        const s = m.index + m[0].length - m[1].length;
        out.push({ start: s, ende: s + w.length, norm: w });
      }
    },
    AHV(text, out) {
      for (const m of text.matchAll(/(?<![\d.])756[.\s-]?\d{4}[.\s-]?\d{4}[.\s-]?\d{2}(?![\d])/g)) {
        const d = m[0].replace(/\D/g, '');
        if (ean13Ok(d)) out.push({ start: m.index, ende: m.index + m[0].length, norm: d });
      }
    },
    IBAN(text, out) {
      for (const m of text.matchAll(/\b(?:CH|LI)\d{2}(?:[ ]?[0-9A-Z]{4}){4}[ ]?[0-9A-Z]\b/gi)) {
        const n = m[0].replace(/\s/g, '').toUpperCase();
        if (n.length === 21 && mod97(n)) out.push({ start: m.index, ende: m.index + m[0].length, norm: n });
      }
    },
    KREDITKARTE(text, out) {
      for (const m of text.matchAll(/(?<![\d])(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19})(?![\d])/g)) {
        const d = m[0].replace(/\D/g, '');
        const gruppiert = /[ -]/.test(m[0]);
        if (!gruppiert && d.length !== 16) continue;
        if (!/^[2-6]/.test(d)) continue;
        if (luhnOk(d)) out.push({ start: m.index, ende: m.index + m[0].length, norm: d });
      }
    },
    EMAIL(text, out) {
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
        out.push({ start: m.index, ende: m.index + m[0].length, norm: m[0].toLowerCase() });
      }
    },
    TELEFON(text, out) {
      const re = /(?<![\w+])(?<!\d[.,])(?:(?:\+|00)41[ .-]?\(?0?\)?[ .-]?\d{2}[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}|0\d{2}[ ./-]?\d{3}[ .-]?\d{2}[ .-]?\d{2})(?![\w])/g;
      for (const m of text.matchAll(re)) {
        let d = m[0].replace(/\D/g, '');
        if (d.startsWith('0041')) d = '0' + d.slice(4); else if (/^\+/.test(m[0]) && d.startsWith('41')) d = '0' + d.slice(2);
        if (d.length === 11 && d[1] === '0') d = d.slice(1);
        if (d.length !== 10 || d[0] !== '0' || !VORWAHLEN.has(d.slice(1, 3))) continue;
        out.push({ start: m.index, ende: m.index + m[0].length, norm: d });
      }
    },
    UID(text, out) {
      for (const m of text.matchAll(/\bCHE[-\s]?(\d{3})\.?(\d{3})\.?(\d{3})(?:\s?(?:MWST|TVA|IVA))?/g)) {
        const d = m[1] + m[2] + m[3];
        if (uidOk(d)) out.push({ start: m.index, ende: m.index + m[0].length, norm: d });
      }
    },
    GEBURTSDATUM(text, out) {
      const kw = /(?:\bgeboren(?:\s+am)?|\bgeb\.|\bGeburtsdatum|\bGeburtstag|\bJahrgang|\bborn|\bDOB)[ \t]*[:=]?[ \t]*/gi;
      for (const k of text.matchAll(kw)) {
        const von = k.index + k[0].length;
        const rest = text.slice(von, von + 40);
        let m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?((?:19|20)?\d{2})(?!\d)/.exec(rest);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
          out.push({ start: von, ende: von + m[0].length, norm: `${m[1]}.${m[2]}.${m[3]}` }); continue;
        }
        m = new RegExp(`^(\\d{1,2})\\.?\\s*${MONATE}\\s+(?:19|20)\\d{2}`, 'i').exec(rest);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) { out.push({ start: von, ende: von + m[0].length, norm: m[0].toLowerCase() }); continue; }
        m = /^(?:19|20)\d{2}(?!\d)/.exec(rest);
        if (m && /jahrgang/i.test(k[0])) out.push({ start: von, ende: von + m[0].length, norm: m[0] });
      }
    },
    NAME(text, out) {
      const re = /\b(?:Herr|Herrn|Frau|Hr\.|Fr\.)\s+(?:(?:Dr\.|Prof\.|Dipl\.)\s*)*(?:(?:med|iur|oec|phil|ing)\.\s*)*[A-ZÄÖÜ][a-zäöüéèàß'-]{2,}(?:-[A-ZÄÖÜ][a-zäöüéèàß]+)?/g;
      const nie = /^(?:Herr|Frau)\s+(?:Direktor|Präsident|Praesident|Doktor|Professor|Kollege|Kollegin|Nachbar|Meier-)$/;
      for (const m of text.matchAll(re)) {
        if (nie.test(m[0])) continue;
        out.push({ start: m.index, ende: m.index + m[0].length, norm: m[0].replace(/^(Herrn?|Frau|Hr\.|Fr\.)\s+/, '').toLowerCase() });
      }
    }
  };
}
const REIHENFOLGE = ['SCHLUESSEL', 'AHV', 'IBAN', 'KREDITKARTE', 'EMAIL', 'GEBURTSDATUM', 'UID', 'TELEFON', 'NAME'];

// ── Abbild ──────────────────────────────────────────────────────────────────
// Eine Anfrage legt ein Abbild an und reicht es an alle Texte weiter, damit gleiche Werte denselben Platzhalter erhalten.
function neuesAbbild() { return { zuWert: Object.create(null), zuPlatzhalter: Object.create(null), zaehler: Object.create(null) }; }

function platzhalterFuer(abbild, typ, norm, wert) {
  const key = typ + '|' + norm;
  let p = abbild.zuPlatzhalter[key];
  if (!p) {
    const n = (abbild.zaehler[typ] = (abbild.zaehler[typ] || 0) + 1);
    p = `[${TYPEN[typ].platz}-${n}]`;
    abbild.zuPlatzhalter[key] = p;
    abbild.zuWert[p] = wert;
  }
  return p;
}

// erkenne(text, { typen, abbild }) -> [{ typ, start, ende, schwere, platzhalter }] sortiert nach Position, ohne Überlappung
function erkenne(text, optionen = {}) {
  if (typeof text !== 'string' || !text) return [];
  const aktiv = new Set(Array.isArray(optionen.typen) ? optionen.typen : STANDARD_TYPEN);
  const abbild = optionen.abbild || neuesAbbild();
  const r = regeln();
  const kand = [];
  for (const typ of REIHENFOLGE) {
    if (!aktiv.has(typ)) continue;
    const out = [];
    r[typ](text, out);
    for (const c of out) kand.push({ typ, ...c });
  }
  // Überlappungen: höhere Schwere gewinnt, bei Gleichstand der frühere Typ in REIHENFOLGE, dann der längere Treffer
  kand.sort((a, b) => (SCHWERE_RANG[TYPEN[b.typ].schwere] - SCHWERE_RANG[TYPEN[a.typ].schwere])
    || (REIHENFOLGE.indexOf(a.typ) - REIHENFOLGE.indexOf(b.typ)) || ((b.ende - b.start) - (a.ende - a.start)));
  const gewaehlt = [];
  for (const c of kand) if (!gewaehlt.some(g => c.start < g.ende && c.ende > g.start)) gewaehlt.push(c);
  gewaehlt.sort((a, b) => a.start - b.start);
  return gewaehlt.map(c => ({
    typ: c.typ, start: c.start, ende: c.ende, schwere: TYPEN[c.typ].schwere,
    platzhalter: platzhalterFuer(abbild, c.typ, c.norm, text.slice(c.start, c.ende))
  }));
}

// schuetze(text, modus, { typen, abbild }) -> { text, funde, abbild }
// Modus «ersetzen» tauscht jeden Fund gegen seinen Platzhalter, jeder andere Modus lässt den Text unverändert.
function schuetze(text, modus, optionen = {}) {
  const abbild = optionen.abbild || neuesAbbild();
  const funde = erkenne(text, { typen: optionen.typen, abbild });
  if (modus !== 'ersetzen' || !funde.length) return { text, funde, abbild };
  let aus = '', pos = 0;
  for (const f of funde) { aus += text.slice(pos, f.start) + f.platzhalter; pos = f.ende; }
  return { text: aus + text.slice(pos), funde, abbild };
}

const PLATZHALTER_RE = /\[[A-Z-]+-\d+\]/g;
function stelleWiederHer(text, abbild) {
  if (typeof text !== 'string' || !text || !abbild || !text.includes('[')) return text;
  return text.replace(PLATZHALTER_RE, (p) => (Object.prototype.hasOwnProperty.call(abbild.zuWert, p) ? abbild.zuWert[p] : p));
}
function abbildLeer(abbild) { return !abbild || Object.keys(abbild.zuWert).length === 0; }

// Puffer für Streaming: ein Platzhalter, der über Chunk-Grenzen geteilt ankommt, wird erst ausgegeben, wenn er vollständig ist.
const MAX_PLATZHALTER = 28;
function neuerRueckwandler(abbild) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk || '';
      const auf = buf.lastIndexOf('[');
      if (auf >= 0 && buf.indexOf(']', auf) === -1 && buf.length - auf <= MAX_PLATZHALTER) {
        const fertig = buf.slice(0, auf);
        buf = buf.slice(auf);
        return stelleWiederHer(fertig, abbild);
      }
      const fertig = buf; buf = '';
      return stelleWiederHer(fertig, abbild);
    },
    ende() { const r = stelleWiederHer(buf, abbild); buf = ''; return r; }
  };
}

const SYSTEM_HINWEIS = 'Hinweis zum Datenschutz: Platzhalter in eckigen Klammern wie [IBAN-1], [E-MAIL-1] oder [TELEFON-1] stehen für vertrauliche Angaben. '
  + 'Übernimm sie unverändert in deine Antwort und versuche nicht, sie zu erraten oder zu ergänzen.';

// Gruppiert Funde für die Anzeige: [{ typ, label, anzahl, schwere }]
function gruppiere(funde) {
  const m = new Map();
  for (const f of funde) {
    const g = m.get(f.typ) || { typ: f.typ, label: TYPEN[f.typ].label, schwere: f.schwere, anzahl: 0 };
    g.anzahl++; m.set(f.typ, g);
  }
  return [...m.values()];
}

// Maskierte Vorschau (nie der volle Wert): Struktur bleibt sichtbar, Ziffern und Buchstaben werden zu Punkten
function maskiere(typ, wert) {
  const maske = (s, behalte) => { let i = 0; return s.replace(/[A-Za-z0-9ÄÖÜäöüéèà]/g, (c) => (i++ < behalte ? c : '•')); };
  switch (typ) {
    case 'AHV': return maske(wert, 3);
    case 'IBAN': return maske(wert, 4);
    case 'KREDITKARTE': return maske(wert.slice(0, -4), 0) + wert.slice(-4);
    case 'EMAIL': { const [l, d] = wert.split('@'); const tld = d.slice(d.lastIndexOf('.')); return l.slice(0, 1) + '•'.repeat(Math.min(Math.max(l.length - 1, 2), 6)) + '@•••' + tld; }
    case 'TELEFON': return maske(wert, /^\+/.test(wert) ? 2 : 3);
    case 'UID': return maske(wert, 3);
    case 'GEBURTSDATUM': return maske(wert, 0);
    case 'SCHLUESSEL': return maske(wert, Math.min(3, Math.floor(wert.length / 4)));
    case 'NAME': { const t = wert.split(/\s+/); return t.map((w, i) => (i === t.length - 1 ? w.slice(0, 1) + '•'.repeat(Math.min(Math.max(w.length - 1, 2), 6)) : w)).join(' '); }
    default: return '•••';
  }
}

module.exports = {
  TYPEN, ALLE_TYPEN, STANDARD_TYPEN, SYSTEM_HINWEIS, MAX_PLATZHALTER,
  erkenne, schuetze, stelleWiederHer, neuesAbbild, abbildLeer, neuerRueckwandler, gruppiere, maskiere,
  _pruef: { ean13Ok, luhnOk, mod97, uidOk }
};
