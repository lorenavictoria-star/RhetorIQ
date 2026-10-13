// Kunden-PDF des Stimm-Schnelltests (A4, drei Seiten, Schwarz auf Weiss mit dezentem Dunkelgrün, Helvetica wie bei den Geschenk-PDFs).
// Seite 1: Briefkopf, Titel, Gesamteindruck, Kennzahlen, Stärken. Seiten 2 und 3: die drei gewählten Auffälligkeiten,
// Lorenas Einschätzung, nächster Schritt, Kontakt. Passt der Inhalt nicht auf drei Seiten, wird die Schrift schrittweise kleiner.
const PDFDocument = require('pdfkit');
const { NEXT_STEP } = require('./schnelltestAnalyse');

const GRUEN = '#1f4d3a', TEXT = '#111111', GRAU = '#555555', LINIE = '#d6dbd8', FLAECHE = '#f3f6f4';
const R = 56, SEITE_B = 595.28, SEITE_H = 841.89, BREITE = SEITE_B - 2 * R, UNTEN = SEITE_H - 70;
const GRAD = [1, 0.94, 0.88, 0.82, 0.76];

// Standard-Schrift (WinAnsi): alles ausserhalb davon entfernen, damit keine falschen Zeichen erscheinen
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function sauber(s) {
  return Array.from(String(s == null ? '' : s).replace(/ /g, ' ').replace(/[‐‑]/g, '-').replace(/…/g, '…')).filter(ch => {
    const c = ch.codePointAt(0);
    return c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_EXTRA.includes(ch);
  }).join('');
}
const dat = (d) => new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Zurich' }).format(d instanceof Date ? d : new Date(d));
const komma = (n) => String(n).replace('.', ',');

function kennzeilen(k) {
  const z = [];
  if (!k) return z;
  if (k.woerterProSatz != null) {
    z.push(['Wörter pro Satz im Durchschnitt', komma(k.woerterProSatz)]);
    z.push(['Anteil Sätze mit mehr als 25 Wörtern', `${k.anteilLangeSaetze} Prozent (${k.langeSaetze} von ${k.saetze} Sätzen)`]);
  }
  if (k.wir != null) z.push(['Wir-Wörter zu Sie-Wörtern (mitten im Satz)', `${k.wir} zu ${k.sie}`]);
  if (k.floskeln) {
    const n = (k.floskeln.liste || []).slice(0, 3).map(x => `«${x.floskel}»`).join(', ');
    z.push(['Bekannte Werbewendungen', `${k.floskeln.treffer} Treffer${k.floskeln.treffer && n ? ', zum Beispiel ' + n : ''}`]);
  }
  if (k.nominalstil) z.push(['Wörter auf -ung, -keit, -heit (Näherung)', `${komma(k.nominalstil.anteil)} Prozent`]);
  if (k.passiv) z.push(['Sätze im Passiv (Näherung)', `${k.passiv.anteil} Prozent`]);
  return z;
}

// Zeichenwerkzeuge für ein Dokument (auch für Probemessungen auf einem hohen Probeblatt)
function werkzeuge(doc, g) {
  const S = (n) => Math.round(n * g * 10) / 10;
  const T = sauber;
  const hoehe = (txt, w, size, font = 'Helvetica', gap = 2) => { doc.font(font).fontSize(size); return doc.heightOfString(T(txt), { width: w, lineGap: gap }); };
  const absatz = (txt, { size = 10, font = 'Helvetica', color = TEXT, w = BREITE, x = R, gap = 2.5, after = 6 } = {}) => {
    doc.font(font).fontSize(S(size)).fillColor(color).text(T(txt), x, doc.y, { width: w, lineGap: gap });
    doc.y += after;
  };
  const label = (txt) => { doc.font('Helvetica-Bold').fontSize(S(8)).fillColor(GRUEN).text(T(txt).toUpperCase(), R, doc.y, { width: BREITE, characterSpacing: 0.8 }); doc.y += 2; };
  const linie = (y = doc.y, farbe = LINIE) => { doc.save().moveTo(R, y).lineTo(SEITE_B - R, y).lineWidth(0.6).strokeColor(farbe).stroke().restore(); };

  const kandidat = (c, nr) => {
    label(`Auffälligkeit ${nr} · ${c.kategorie}`);
    doc.font('Helvetica-Bold').fontSize(S(12.5)).fillColor(TEXT).text(T(c.titel), R, doc.y, { width: BREITE, lineGap: 2 });
    doc.y += 6;
    const kopf = (t) => { doc.font('Helvetica-Bold').fontSize(S(8.5)).fillColor(GRUEN).text(T(t), R, doc.y, { width: BREITE }); doc.y += 1.5; };
    kopf('Was ich gelesen habe');
    const hb = hoehe('«' + c.beleg + '»', BREITE - 16, S(9.5)) + 8; const yb = doc.y;
    doc.save().rect(R, yb, BREITE, hb).fill(FLAECHE).rect(R, yb, 2.4, hb).fill(GRUEN).restore();
    doc.font('Helvetica').fontSize(S(9.5)).fillColor(TEXT).text(T('«' + c.beleg + '»'), R + 10, yb + 4, { width: BREITE - 16, lineGap: 2 });
    doc.y = yb + hb + 5;
    kopf('Warum das so wirkt');
    absatz(c.warum, { size: 9.5, after: 5 });
    kopf('Der Aha-Moment');
    absatz(c.aha, { size: 10, font: 'Helvetica-Bold', color: GRUEN, after: 5 });
    kopf('Heute / Vorschlag');
    const w = (BREITE - 12) / 2; const y0 = doc.y;
    const h = Math.max(hoehe(c.vorher, w - 14, S(9)), hoehe(c.nachher, w - 14, S(9))) + 24;
    [['Heute', c.vorher, R, LINIE], ['Vorschlag', c.nachher, R + w + 12, GRUEN]].forEach(([t, txt, x, farbe]) => {
      doc.save().rect(x, y0, w, h).lineWidth(0.8).strokeColor(farbe).stroke().restore();
      doc.font('Helvetica-Bold').fontSize(S(7.5)).fillColor(farbe === GRUEN ? GRUEN : GRAU).text(T(t).toUpperCase(), x + 7, y0 + 6, { width: w - 14, characterSpacing: 0.6 });
      doc.font('Helvetica').fontSize(S(9)).fillColor(TEXT).text(T(txt), x + 7, y0 + 18, { width: w - 14, lineGap: 2 });
    });
    doc.y = y0 + h + 6;
    kopf('Wirkung');
    absatz(c.wirkung, { size: 9.5, after: 2 });
  };
  const schluss = (notiz) => {
    if (T(notiz).trim()) { label('Lorenas Einschätzung'); absatz(notiz, { size: 10, gap: 3, after: 12 }); }
    label('Nächster Schritt');
    absatz(NEXT_STEP, { size: 10, gap: 3, after: 8 });
    absatz('Kontakt: contact@lorenalienhard.ch', { size: 10, font: 'Helvetica-Bold', color: GRUEN, after: 0 });
  };
  return { S, T, hoehe, absatz, label, linie, kandidat, schluss };
}

// Höhe eines Blocks, gemessen auf einem hohen Probeblatt mit gleichen Massen
function messe(g, fn) {
  const d = new PDFDocument({ size: [SEITE_B, 9000], margins: { top: 0, bottom: 0, left: R, right: R } });
  d.on('data', () => {});
  d.y = 0; fn(werkzeuge(d, g), d);
  const h = d.y; d.end();
  return h;
}

function render(daten, g) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 60, left: R, right: R }, bufferPages: true,
      info: { Title: 'Wie klingt Ihre Webseite?', Author: 'Lorena Lienhard', Subject: 'Stimm-Schnelltest ' + sauber(daten.host || '') } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); let n = 0; doc.on('end', () => resolve({ buf: Buffer.concat(chunks), seiten: n })); doc.on('error', reject);
    const { S, T, hoehe, absatz, label, linie, kandidat, schluss } = werkzeuge(doc, g);

    // ── Seite 1 ──
    doc.font('Helvetica-Bold').fontSize(17).fillColor(GRUEN).text('RhetorIQ', R, 56, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAU).text('Lorena Lienhard · contact@lorenalienhard.ch · rhetoriq.ch', R, 60, { width: BREITE, align: 'right', lineBreak: false });
    linie(84, GRUEN);
    doc.y = 108;
    doc.font('Helvetica-Bold').fontSize(S(26)).fillColor(TEXT).text('Wie klingt Ihre Webseite?', R, doc.y, { width: BREITE });
    doc.y += 8;
    absatz(daten.firma || daten.host, { size: 13, font: 'Helvetica-Bold', color: GRUEN, after: 2 });
    absatz(`${daten.url}   ·   ${dat(daten.datum)}`, { size: 9.5, color: GRAU, after: 14 });

    label('Gesamteindruck');
    absatz(daten.gesamteindruck, { size: 10.5, gap: 3, after: 12 });

    label('Kennzahlen');
    linie(doc.y + 2); doc.y += 6;
    for (const [name, wert] of kennzeilen(daten.kennzahlen)) {
      const y0 = doc.y;
      doc.font('Helvetica').fontSize(S(9.5)).fillColor(GRAU).text(T(name), R, y0, { width: 250 });
      const h1 = doc.y - y0;
      doc.font('Helvetica-Bold').fontSize(S(9.5)).fillColor(TEXT).text(T(wert), R + 262, y0, { width: BREITE - 262 });
      doc.y = Math.max(doc.y, y0 + h1) + 4;
      linie(doc.y - 1);
      doc.y += 3;
    }
    absatz(`Gelesen: ${daten.mehrseiten || 1} ${(daten.mehrseiten || 1) === 1 ? 'Seite' : 'Seiten'}, rund ${(daten.kennzahlen && daten.kennzahlen.woerter) || 0} Wörter. Die Kennzahlen sind automatisch aus den Texten berechnet. Nominalstil und Passiv sind Näherungen.`, { size: 8, color: GRAU, after: 14 });

    if ((daten.staerken || []).length) {
      label('Das gelingt bereits');
      doc.y += 2;
      for (const s of daten.staerken.slice(0, 2)) {
        const y0 = doc.y;
        const hh = hoehe(s.titel, BREITE - 14, S(10.5), 'Helvetica-Bold') + hoehe(s.text, BREITE - 14, S(9.5)) + (s.beleg ? hoehe('«' + s.beleg + '»', BREITE - 14, S(9), 'Helvetica') : 0) + 14;
        doc.save().rect(R, y0, 2.4, hh).fill(GRUEN).restore();
        doc.font('Helvetica-Bold').fontSize(S(10.5)).fillColor(TEXT).text(T(s.titel), R + 12, y0 + 1, { width: BREITE - 14, lineGap: 2 });
        doc.font('Helvetica').fontSize(S(9.5)).fillColor(TEXT).text(T(s.text), R + 12, doc.y + 2, { width: BREITE - 14, lineGap: 2 });
        if (s.beleg) doc.font('Helvetica').fontSize(S(9)).fillColor(GRAU).text(T('«' + s.beleg + '»'), R + 12, doc.y + 3, { width: BREITE - 14, lineGap: 2 });
        doc.y = y0 + hh + 8;
      }
    }

    // ── Auffälligkeiten: fliessend, ein Block bleibt zusammen und rückt bei Platzmangel auf die nächste Seite ──
    doc.addPage(); doc.y = 56;
    let oben = true;
    (daten.kandidaten || []).slice(0, 3).forEach((c, i) => {
      const hc = messe(g, (w) => w.kandidat(c, i + 1));
      if (!oben && doc.y + 18 + hc > UNTEN) { doc.addPage(); doc.y = 56; oben = true; }
      if (!oben) { doc.y += 6; linie(doc.y, LINIE); doc.y += 12; }
      kandidat(c, i + 1);
      oben = false;
    });
    const hs = messe(g, (w) => w.schluss(daten.notiz));
    if (doc.y + 30 + hs > UNTEN) { doc.addPage(); doc.y = 56; } else { doc.y += 12; linie(doc.y, LINIE); doc.y += 12; }
    schluss(daten.notiz);

    // ── Fusszeile ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.save().moveTo(R, SEITE_H - 52).lineTo(SEITE_B - R, SEITE_H - 52).lineWidth(0.5).strokeColor(LINIE).stroke().restore();
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAU)
        .text('Automatisierte Vorauswertung, von Lorena Lienhard geprüft und ausgewählt.', R, SEITE_H - 44, { width: BREITE - 80, lineBreak: false })
        .text(`Seite ${i + 1} von ${range.count}`, R, SEITE_H - 44, { width: BREITE, align: 'right', lineBreak: false });
      doc.page.margins.bottom = mb;
    }
    n = range.count;
    doc.end();
  });
}

// daten: { host, url, firma, datum, gesamteindruck, kennzahlen, mehrseiten, staerken, kandidaten (gewählte, bearbeitet), notiz }
// Ergebnis: { buf, seiten }. Passt der Inhalt auch in der kleinsten Schrift nicht auf drei Seiten, ist seiten grösser als 3,
// dann darf das PDF nicht versendet werden (nichts wird stillschweigend gekürzt).
async function erzeugePdf(daten) {
  let letzte = null;
  for (const g of GRAD) {
    letzte = await render(daten, g);
    if (letzte.seiten <= 3) return letzte;
  }
  return letzte;
}

module.exports = { erzeugePdf, kennzeilen, sauber };
