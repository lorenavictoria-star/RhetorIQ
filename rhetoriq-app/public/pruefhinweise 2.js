/* Regelbasierte Prüfhilfe (ohne KI): findet Zahlen, Prozente, Beträge, Daten und Eigennamen in einem Text.
   Läuft im Browser (window.RQPruef) und in Node (require). Die Namenserkennung ist eine Faustregel:
   Sie meldet zwei oder mehr gross geschriebene Wörter hintereinander, Wörter nach Anrede oder Titel,
   Abkürzungen in Grossbuchstaben und Namen mit Rechtsform (AG, GmbH). Einzelne Hauptwörter bleiben aussen vor. */
(function (root) {
  var MONATE = 'Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';
  var FUNKTION = ['Der','Die','Das','Den','Dem','Des','Ein','Eine','Einen','Einem','Einer','Unser','Unsere','Unseren','Unserem','Unserer','Ihr','Ihre','Ihren','Ihrem','Ihrer','Wir','Sie','Ich','Er','Es','Man','Dies','Diese','Dieser','Dieses','Diesem','Diesen','Mit','Bei','Für','Fuer','Von','Vom','Zu','Zum','Zur','Nach','Vor','Über','Ueber','Auf','Aus','An','Am','Im','In','Um','Und','Oder','Aber','Denn','Weil','Wenn','Als','Auch','Noch','Nur','Heute','Gestern','Morgen','Jetzt','Dann','Danach','Zudem','Ausserdem','Damit','Dabei','Dafür','Hier','Dort','Alle','Jede','Jeder','Jedes','Viele','Mehr','Sehr','Bitte','Herzlichen','Freundliche','Liebe','Lieber','Sehr','Guten','Gerne','Leider','Vielen','Beste','Besten'];
  var TITEL = ['Herr','Herrn','Frau','Dr','Prof','Dipl','Direktor','Direktorin','CEO','CFO','Präsident','Präsidentin','Firma','Unternehmen','Stadt','Kanton','Gemeinde'];
  var RECHTSFORM = ['AG','GmbH','SA','Sàrl','KG','Ltd','Inc','SE','Co'];
  var MAX = 12;

  function uniq(arr) { var seen = {}, out = []; arr.forEach(function (x) { var k = x.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(x); } }); return out.slice(0, MAX); }
  function mask(text, re, collect) {
    return text.replace(re, function (m) { collect.push(m.trim()); return ' '.repeat(m.length); });
  }

  function find(text) {
    text = String(text || '');
    var daten = [], prozent = [], betraege = [], zahlen = [], namen = [];
    var t = text;
    // Daten: 12.03.2026, 12. März 2026, März 2026, 2026-03-12
    t = mask(t, /\b\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})\b/g, daten);
    t = mask(t, /\b\d{4}-\d{2}-\d{2}\b/g, daten);
    t = mask(t, new RegExp('\\b\\d{1,2}\\.\\s?(?:' + MONATE + ')(?:\\s\\d{4})?', 'g'), daten);
    t = mask(t, new RegExp('\\b(?:' + MONATE + ')\\s\\d{4}\\b', 'g'), daten);
    t = mask(t, /\b(?:19|20)\d{2}\b/g, daten);
    // Prozente
    t = mask(t, /\d+(?:[.,']\d+)*\s?(?:%|Prozent|Promille)/g, prozent);
    // Beträge
    t = mask(t, /(?:CHF|EUR|USD|Fr\.|SFr\.|€|\$)\s?\d+(?:['’.,]\d+)*(?:\s?(?:Mio\.?|Mrd\.?|Millionen|Milliarden|Tsd\.?))?/g, betraege);
    t = mask(t, /\d+(?:['’.,]\d+)*(?:\s?(?:Mio\.?|Mrd\.?|Millionen|Milliarden))?\s?(?:CHF|EUR|USD|Franken|Fr\.|Euro|Dollar|€)/g, betraege);
    // Übrige Zahlen: ab zwei Stellen oder mit Dezimalstellen, oder Zahl mit Mengenwort
    t = mask(t, /\b\d+(?:['’.,]\d+)+\b|\b\d{2,}\b|\b\d+\s?(?:Mio\.?|Mrd\.?|Millionen|Milliarden|Tausend|Kunden|Mitarbeitende|Mitarbeiter|Personen|Stunden|Tage|Tagen|Wochen|Monate|Monaten|Jahre|Jahren|Franken)/g, zahlen);

    // Eigennamen
    var tokRe = /([A-Za-zÄÖÜäöüéèàç][\wÄÖÜäöüéèàç'’\-]*|[.!?:;\n•\-–—]+|\S)/g;
    var toks = [], m;
    while ((m = tokRe.exec(t))) toks.push(m[0]);
    var sentStart = true;
    var run = [];
    function isCap(w) { return /^[A-ZÄÖÜ]/.test(w); }
    function flush() {
      if (run.length) {
        var words = run.map(function (r) { return r.w; });
        var first = run[0];
        while (words.length && FUNKTION.indexOf(words[0]) >= 0) words = words.slice(1);
        while (words.length && TITEL.indexOf(words[0]) >= 0) words = words.slice(1);
        var ok = false;
        if (words.length >= 2) ok = true;
        else if (words.length === 1) {
          var one = run[run.length - 1];
          if (run.length > 1 && TITEL.indexOf(run[run.length - 2].w) >= 0) ok = true;
          else if (/^[A-ZÄÖÜ]{2,}$/.test(words[0]) && !(one.start)) ok = true;
          else if (/^[A-ZÄÖÜ][a-zäöü]+[A-Z]/.test(words[0])) ok = true;
          else if (one.beforeRechtsform) ok = true;
        }
        if (ok && words.length) namen.push(words.join(' '));
      }
      run = [];
    }
    var prev = null;
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i];
      if (/^[.!?:;\n•\-–—]+$/.test(w)) { flush(); if (/[.!?:\n•]/.test(w)) sentStart = true; prev = w; continue; }
      if (!/^[A-Za-zÄÖÜäöüéèàç]/.test(w)) { flush(); prev = w; sentStart = false; continue; }
      if (isCap(w) && w.length > 1) {
        var isRF = RECHTSFORM.indexOf(w) >= 0;
        if (isRF && run.length) { run.push({ w: w, start: false }); }
        else {
          var item = { w: w, start: sentStart && !run.length, afterTitel: prev && TITEL.indexOf(String(prev).replace(/\.$/, '')) >= 0 };
          var nxt = toks[i + 1];
          item.beforeRechtsform = nxt && RECHTSFORM.indexOf(nxt) >= 0;
          run.push(item);
        }
        if (isRF) flush();
      } else flush();
      prev = w; sentStart = false;
    }
    flush();
    // Titelwörter und Funktionswörter selbst sind keine Namen
    namen = namen.filter(function (n) { return TITEL.indexOf(n) < 0 && FUNKTION.indexOf(n) < 0; });
    var out = { daten: uniq(daten), prozent: uniq(prozent), betraege: uniq(betraege), zahlen: uniq(zahlen), namen: uniq(namen) };
    out.total = out.daten.length + out.prozent.length + out.betraege.length + out.zahlen.length + out.namen.length;
    return out;
  }

  var LABEL = { namen: 'Namen', zahlen: 'Zahlen', prozent: 'Prozente', betraege: 'Beträge', daten: 'Daten' };
  function summary(r) {
    return ['namen', 'zahlen', 'prozent', 'betraege', 'daten'].filter(function (k) { return r[k].length; })
      .map(function (k) { return LABEL[k] + ': ' + r[k].join(', '); });
  }

  var api = { find: find, summary: summary, HINWEIS: 'Bitte prüfen Sie Zahlen, Namen und Daten vor dem Versand.' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RQPruef = api;
})(typeof window !== 'undefined' ? window : this);
