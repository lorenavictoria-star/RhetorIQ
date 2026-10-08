const ExcelJS = require('exceljs');

// Excel-Liste aller Texte einer Woche für den Wochenbericht.
// rows: [{ created_at, client_name, module_label, user_rating, result }]
// Gibt einen Buffer (.xlsx) zurück.
async function buildWeeklyTextsXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RhetorIQ';
  wb.created = new Date();
  const ws = wb.addWorksheet('Texte der Woche', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Datum', key: 'datum', width: 18 },
    { header: 'Klient', key: 'klient', width: 26 },
    { header: 'Textart', key: 'textart', width: 24 },
    { header: 'Bewertung', key: 'bewertung', width: 12 },
    { header: 'Text', key: 'text', width: 110 }
  ];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  const fmt = (t) => new Date(t).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const r of rows) {
    const rating = r.user_rating === 1 ? 'gut' : r.user_rating === -1 ? 'schlecht' : '';
    // Excel erlaubt höchstens 32767 Zeichen pro Zelle
    const text = String(r.result || '').slice(0, 32000);
    const row = ws.addRow({ datum: fmt(r.created_at), klient: r.client_name || 'Ohne Klient', textart: r.module_label || r.module || '', bewertung: rating, text });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  ws.autoFilter = { from: 'A1', to: 'E1' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWeeklyTextsXlsx };
