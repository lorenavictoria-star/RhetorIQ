/* Faktenmarker (ohne KI): markiert im Ergebnis Zahlen, Prozente, Beträge, Daten und Eigennamen, die NICHT im Auftrag (Briefing) stehen.
   Baut auf der regelbasierten Erkennung in pruefhinweise.js auf (window.RQPruef beziehungsweise require).
   Läuft im Browser (window.RQFakten) und in Node (require). */
(function (root) {
  var Pruef = (typeof module !== 'undefined' && module.exports) ? require('./pruefhinweise.js') : root.RQPruef;
  var KEYS = ['namen', 'zahlen', 'prozent', 'betraege', 'daten'];

  // Zahlenkern: alle Ziffernfolgen, ohne Tausendertrennzeichen (1'200 und 1200 sind dasselbe)
  function zahlen(s) {
    var t = String(s || '').replace(/(\d)[’'](?=\d{3}\b)/g, '$1');
    return t.match(/\d+(?:[.,]\d+)?/g) || [];
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  // Steht der Fund im Auftrag? Mit Ziffern: alle Zahlengruppen kommen im Auftrag vor. Ohne Ziffern: der Name (oder alle seine Wörter).
  function imAuftrag(item, briefingNorm, briefingZahlen) {
    var z = zahlen(item);
    if (z.length) return z.every(function (g) { return briefingZahlen.indexOf(g) >= 0; });
    var n = norm(item);
    if (briefingNorm.indexOf(n) >= 0) return true;
    var w = n.split(' ');
    var da = w.map(function (x) { return x.length > 1 && briefingNorm.indexOf(x) >= 0; });
    if (w.length > 1 && da.every(Boolean)) return true;
    // Die Namenserkennung ist eine Faustregel und nimmt manchmal ein Hauptwort davor mit («Tag Anna Keller»)
    return w.length >= 3 && da.slice(1).every(Boolean);
  }

  // Liefert {segmente:[{text, fakt}], anzahl, funde:[{text, art}]}
  function markiere(ergebnis, briefing) {
    var text = String(ergebnis || '');
    var out = { segmente: [{ text: text, fakt: false }], anzahl: 0, funde: [] };
    if (!text || !Pruef) return out;
    var r = Pruef.find(text);
    var bn = norm(briefing), bz = zahlen(briefing);
    var seen = {}, funde = [];
    KEYS.forEach(function (k) {
      (r[k] || []).forEach(function (item) {
        var key = item.toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        if (!imAuftrag(item, bn, bz)) funde.push({ text: item, art: k });
      });
    });
    if (!funde.length) return out;
    // Fundstellen im Ergebnis, überlappende zusammenführen
    var ranges = [];
    funde.forEach(function (f) {
      var from = 0, i;
      while ((i = text.indexOf(f.text, from)) >= 0) { ranges.push([i, i + f.text.length]); from = i + f.text.length; }
    });
    ranges.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var merged = [];
    ranges.forEach(function (rg) {
      var last = merged[merged.length - 1];
      if (last && rg[0] <= last[1]) last[1] = Math.max(last[1], rg[1]); else merged.push([rg[0], rg[1]]);
    });
    var segs = [], pos = 0;
    merged.forEach(function (rg) {
      if (rg[0] > pos) segs.push({ text: text.slice(pos, rg[0]), fakt: false });
      segs.push({ text: text.slice(rg[0], rg[1]), fakt: true });
      pos = rg[1];
    });
    if (pos < text.length) segs.push({ text: text.slice(pos), fakt: false });
    out.segmente = segs; out.anzahl = merged.length; out.funde = funde;
    return out;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // HTML mit gelber Hinterlegung für die Fundstellen (der Text selbst bleibt unverändert)
  function html(segmente) {
    return segmente.map(function (s) {
      return s.fakt ? '<mark class="rq-fakt" style="background:#fff3a3;color:inherit;padding:0 1px">' + esc(s.text) + '</mark>' : esc(s.text);
    }).join('');
  }
  // Alle Textfelder des Auftrags als ein Briefing-Text
  function briefingAus(data) {
    var teile = [];
    (function walk(v) {
      if (typeof v === 'string') teile.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(data);
    return teile.join('\n');
  }

  var api = { markiere: markiere, html: html, briefingAus: briefingAus, imAuftrag: imAuftrag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RQFakten = api;
})(typeof window !== 'undefined' ? window : this);
