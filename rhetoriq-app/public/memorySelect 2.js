/* Auswahl der Gedächtnis-Einträge nach Relevanz statt nach Reihenfolge (ohne KI).
   Läuft im Browser (window.RQMem) und im Server (server/lib/memorySelect.js verweist hierher).
   Regeln:
   - brand_voice* kommt immer zuerst und vollständig (nie gekürzt, nie weggelassen).
   - ref_tg_<Textart> der gewählten Textart kommt vor allgemeinen Referenzen. Referenzen anderer Textarten gehören nicht zum Auftrag.
   - key_facts kommt vor ref_brand_voice_source. Dazwischen entscheidet die Wortüberlappung des Briefings mit dem Eintrag.
   - Es wird bis zur Gesamtgrenze gefüllt. Was nicht mehr passt, steht in der Liste «omitted» (mit Grund). */
(function (root) {
  var LIMITS = { total: 40000, cap: 15000, capSource: 8000 };
  var STOP = 'aber alle also auch dass dazu dein deine denn dies diese dieser dieses doch eine einen einem einer eines euch haben hatte hier ihre ihren ihrer ihnen kann kein keine machen mein meine mehr muss nach nicht noch oder schon sein seine sich sind sollen soll über unser unsere unter viel vom von vor war waren wenn werden wie wird wir wollen worden wurde zum zur zwischen with that this from have your their will which about'.split(' ');

  function words(s) {
    var out = {};
    (String(s || '').toLowerCase().match(/[a-zäöüéèàç]{4,}/g) || []).forEach(function (w) { if (STOP.indexOf(w) < 0) out[w] = 1; });
    return out;
  }
  // Anteil der Briefing-Wörter, die im Eintrag vorkommen (0 bis 1)
  function overlap(briefingWords, content) {
    var keys = Object.keys(briefingWords);
    if (!keys.length) return 0;
    var low = String(content || '').toLowerCase(), hit = 0;
    keys.forEach(function (w) { if (low.indexOf(w) >= 0) hit++; });
    return hit / keys.length;
  }
  // Gewicht je Typ. Das Briefing kann einen Eintrag innerhalb seiner Gruppe um höchstens 40 Punkte nach oben schieben.
  function weight(type, tile) {
    if (/^brand_voice/.test(type)) return 1000;
    if (tile && type === 'ref_tg_' + tile) return 500;
    if (type === 'key_facts') return 100;
    if (type === 'ref_brand_voice_source') return 20;
    return 60;
  }

  // entries: [{memory_type, content}], opts: {briefing, tile, total, cap, capSource}
  // Ergebnis: {selected:[{type, content, gekuerzt}], omitted:[{type, chars, grund}], gekuerzt:[type], chars}
  function select(entries, opts) {
    opts = opts || {};
    var total = opts.total || LIMITS.total, cap = opts.cap || LIMITS.cap, capSource = opts.capSource || LIMITS.capSource;
    var tile = opts.tile || null;
    var bw = words(opts.briefing);
    var list = [];
    (entries || []).forEach(function (e, i) {
      var t = e && e.memory_type, c = e && e.content;
      if (!t || !c) return;
      if (/^structural_reference/.test(t)) return;                 // kommt vom Server als eigener Block
      if (/^ref_tg_/.test(t) && t !== 'ref_tg_' + tile) return;    // Referenz einer anderen Textart
      list.push({ type: t, content: String(c), order: i, score: weight(t, tile) + 40 * overlap(bw, c) });
    });
    list.sort(function (a, b) { return b.score - a.score || a.order - b.order; });

    var selected = [], omitted = [], gekuerzt = [], used = 0;
    list.forEach(function (it) {
      var isBV = /^brand_voice/.test(it.type);
      var c = it.content, short = false;
      if (!isBV) {
        var limit = it.type === 'ref_brand_voice_source' ? capSource : cap;
        if (c.length > limit) { c = c.slice(0, limit) + '\n[…gekürzt]'; short = true; }
      }
      if (!isBV && used + c.length > total) { omitted.push({ type: it.type, chars: it.content.length, grund: 'Länge' }); return; }
      used += c.length;
      selected.push({ type: it.type, content: c, raw: it.content, gekuerzt: short });
      if (short) gekuerzt.push(it.type);
    });
    return { selected: selected, omitted: omitted, gekuerzt: gekuerzt, chars: used };
  }

  var api = { select: select, overlap: overlap, words: words, LIMITS: LIMITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RQMem = api;
})(typeof window !== 'undefined' ? window : this);
