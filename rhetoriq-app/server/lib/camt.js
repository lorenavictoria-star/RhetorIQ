// Zahlungseingänge aus einer Bankdatei lesen: ISO 20022 camt.054 (Gutschriftsanzeige) oder camt.053 (Kontoauszug), wie sie
// E-Banking und Bank-Software der Schweizer Banken liefern. Gelesen werden nur Gutschriften (CRDT) mit Referenz.
// Der Inhalt wird nicht als XML mit Entitäten verarbeitet, sondern mit festen Mustern gelesen. Dateien mit DOCTYPE oder ENTITY werden abgelehnt.
const MAX_ZEICHEN = 8 * 1024 * 1024;

function lies(xml) {
  const text = String(xml || '');
  if (!text.trim()) throw Object.assign(new Error('Die Datei ist leer.'), { status: 400 });
  if (text.length > MAX_ZEICHEN) throw Object.assign(new Error('Die Datei ist zu gross.'), { status: 400 });
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Object.assign(new Error('Diese Datei wird nicht gelesen (enthält DOCTYPE oder ENTITY).'), { status: 400 });
  if (!/<(?:\w+:)?Ntry>/.test(text)) throw Object.assign(new Error('Das ist keine camt.054- oder camt.053-Datei der Bank.'), { status: 400 });
  const x = text.replace(/<(\/?)[A-Za-z0-9_.-]+:/g, '<$1');       // Namespace-Vorsätze entfernen
  const out = [];
  const betrag = (s) => Math.round(parseFloat(s) * 100);
  for (const m of x.matchAll(/<Ntry>([\s\S]*?)<\/Ntry>/g)) {
    const e = m[1];
    const ohneDetails = e.replace(/<NtryDtls>[\s\S]*?<\/NtryDtls>/g, '');
    if (!/<CdtDbtInd>\s*CRDT\s*<\/CdtDbtInd>/.test(ohneDetails)) continue;      // nur Gutschriften
    if (/<RvslInd>\s*true\s*<\/RvslInd>/i.test(ohneDetails)) continue;          // Storno-Buchung
    const dm = ohneDetails.match(/<BookgDt>\s*<Dt(?:Tm)?>([^<]+)</) || ohneDetails.match(/<ValDt>\s*<Dt(?:Tm)?>([^<]+)</);
    const datum = dm ? dm[1].slice(0, 10) : null;
    const am = ohneDetails.match(/<Amt[^>]*Ccy="([A-Z]{3})"[^>]*>\s*([\d.]+)\s*</);
    const details = [...e.matchAll(/<TxDtls>([\s\S]*?)<\/TxDtls>/g)].map(d => d[1]);
    const teile = details.length ? details : [e];
    for (const t of teile) {
      const rm = t.match(/<CdtrRefInf>[\s\S]*?<Ref>\s*([^<]+?)\s*<\/Ref>/);
      if (!rm) continue;
      const ta = t.match(/<TxAmt>\s*<Amt[^>]*Ccy="([A-Z]{3})"[^>]*>\s*([\d.]+)\s*</);
      const a = ta || (details.length <= 1 ? am : null);
      if (!a) continue;
      const nm = t.match(/<Dbtr>[\s\S]*?<Nm>\s*([^<]*?)\s*<\/Nm>/);
      out.push({ referenz: rm[1].replace(/\s+/g, '').toUpperCase(), waehrung: a[1], betragRappen: betrag(a[2]), datum, zahler: nm ? nm[1] : '' });
    }
  }
  return out;
}

module.exports = { lies, MAX_ZEICHEN };
