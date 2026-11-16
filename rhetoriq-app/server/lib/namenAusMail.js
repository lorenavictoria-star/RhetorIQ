// Vor- und Nachname aus dem Teil vor dem @ einer E-Mail-Adresse, soweit er sich erkennen lässt.
// vorname.nachname@firma.ch gibt beide Namen. Ein einzelnes Wort (froschauer@firma.ch) gilt als Nachname vorgeschlagen, ohne Vorname.
// Sammeladressen (info@, contact@, office@ ...) und Adressen mit Ziffern liefern nichts. Es wird kein Geschlecht abgeleitet.
const SAMMEL = new Set(['info', 'kontakt', 'contact', 'office', 'mail', 'email', 'hello', 'hallo', 'admin', 'service', 'support', 'team', 'sekretariat', 'empfang', 'verkauf', 'marketing', 'post', 'mailbox', 'noreply', 'no-reply', 'webmaster', 'buchhaltung', 'bestellung', 'bestellungen', 'reservation', 'reservationen', 'jobs', 'personal', 'direktion', 'geschaeftsleitung', 'kundenservice', 'kundendienst', 'servizioclienti', 'contatto', 'ufficio', 'segreteria']);
const gross = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const teilName = (t) => t.split(/-/).map(gross).join('-');

function namenAusMail(email) {
  const lokal = String(email || '').split('@')[0].trim().toLowerCase().replace(/\+.*$/, '');
  if (!lokal || /\d/.test(lokal) || SAMMEL.has(lokal)) return { vorname: '', nachname: '' };
  const teile = lokal.split(/[._]+/).filter(Boolean);
  if (teile.some(t => !/^[a-zäöüéèàçñ-]+$/.test(t) || SAMMEL.has(t))) return { vorname: '', nachname: '' };
  if (teile.length >= 2 && teile[0].length >= 2) return { vorname: teilName(teile[0]), nachname: teilName(teile[teile.length - 1]) };
  if (teile.length === 1 && teile[0].length >= 4) return { vorname: '', nachname: teilName(teile[0]) };
  return { vorname: '', nachname: '' };
}
module.exports = { namenAusMail };
