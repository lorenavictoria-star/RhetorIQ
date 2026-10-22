// Rechnung per Überweisung mit Schweizer QR-Einzahlungsschein (statt Kartenzahlung über Stripe).
// Ablauf: Beraterin erstellt die Rechnung, sendet sie als PDF per Mail, markiert sie nach dem Zahlungseingang als bezahlt.
// «Bezahlt» schaltet das Abo frei (wie der Stripe-Webhook) und setzt clients.bezahlt_bis. Danach bleibt der Zugang bis zum Ende der
// bezahlten Zeit plus Kulanz (RECHNUNG_KULANZ_TAGE, Standard 10) offen (lib/abo.js). Klienten mit Stripe-Abo haben bezahlt_bis NULL.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { ANGEBOTE } = require('./angebote');
const U = require('swissqrbill/utils');

// Posten, die sich in Rechnung stellen lassen. tokens: Monatskontingent nach der Zahlung (null = unbegrenzt), art: Wirkung bei «bezahlt»
const POSTEN = {
  stimme:   { label: 'Paket Stimme', cents: ANGEBOTE.stimme.amountCents, art: 'paket', tokens: 200000, laufzeit: true },
  team:     { label: 'Paket Team', cents: ANGEBOTE.team.amountCents, art: 'paket', tokens: 750000, laufzeit: true },
  business: { label: 'Paket Business', cents: ANGEBOTE.business.amountCents, art: 'paket', tokens: 2000000, laufzeit: true },
  enterprise: { label: 'Paket Enterprise', cents: 249000, art: 'paket', tokens: null, laufzeit: true },
  quartalsreview: { label: 'Zusatz Quartalsreview (alle 3 Monate)', cents: ANGEBOTE.quartalsreview.amountCents, art: 'quartalsreview' },
  'stimm-audit': { label: '«Die Stimme finden» (30 Tage Zugang inklusive)', cents: ANGEBOTE['stimm-audit'].amountCents, art: 'audit' },
  'workshop-team': { label: 'Workshop «Die Stimme finden» (Team)', cents: ANGEBOTE['workshop-team'].amountCents, art: 'einmalig' },
  'workshop-business': { label: 'Workshop «Die Stimme finden» (Business)', cents: ANGEBOTE['workshop-business'].amountCents, art: 'einmalig' },
  andere: { label: 'Leistung nach Vereinbarung', cents: 0, art: 'einmalig', freitext: true }
};
const JAHRESRABATT = 0.9;   // wie lib/yearlyPlan.js: Jahreszahlung mit 10 Prozent Rabatt
const KULANZ_TAGE = () => { const n = parseInt(process.env.RECHNUNG_KULANZ_TAGE, 10); return Number.isFinite(n) && n >= 0 ? n : 10; };

function betragFuer(posten, laufzeit) {
  const p = POSTEN[posten];
  if (!p) return null;
  if (p.laufzeit && laufzeit === 'jahr') return Math.round(p.cents * 12 * JAHRESRABATT);
  return p.cents;
}

// ── Einstellungen (Absender der Rechnung) ─────────────────────────────────────
const FELDER = ['name', 'strasse', 'hausnr', 'plz', 'ort', 'land', 'iban', 'email', 'uid', 'mwst_hinweis', 'zahlungsfrist_tage'];
async function holeEinstellungen() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM rechnung_einstellungen WHERE id=1');
  const r = rows[0] || {};
  return { name: r.name || '', strasse: r.strasse || '', hausnr: r.hausnr || '', plz: r.plz || '', ort: r.ort || '', land: r.land || 'CH', iban: r.iban || '',
    email: r.email || '', uid: r.uid || '', mwst_hinweis: r.mwst_hinweis || '', zahlungsfrist_tage: Number(r.zahlungsfrist_tage) || 30 };
}
function pruefeEinstellungen(e) {
  const fehler = [];
  if (!String(e.name || '').trim() || String(e.name).length > 70) fehler.push('Name oder Firma fehlt oder ist zu lang (höchstens 70 Zeichen).');
  if (!String(e.strasse || '').trim() || String(e.strasse).length > 70) fehler.push('Strasse fehlt.');
  if (!/^\d{4}$/.test(String(e.plz || '').trim())) fehler.push('Die Postleitzahl muss vierstellig sein.');
  if (!String(e.ort || '').trim() || String(e.ort).length > 35) fehler.push('Ort fehlt.');
  if (!['CH', 'LI'].includes(String(e.land || 'CH').toUpperCase())) fehler.push('Das Land muss CH oder LI sein.');
  const iban = String(e.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^(CH|LI)\d{2}[0-9A-Z]{17}$/.test(iban) || !U.isIBANValid(iban)) fehler.push('Die IBAN ist ungültig. Es braucht eine Schweizer oder liechtensteinische IBAN.');
  if (e.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(String(e.email))) fehler.push('Die E-Mail-Adresse ist ungültig.');
  const t = Number(e.zahlungsfrist_tage);
  if (!Number.isInteger(t) || t < 1 || t > 120) fehler.push('Die Zahlungsfrist muss zwischen 1 und 120 Tagen liegen.');
  return fehler;
}
async function speichereEinstellungen(e) {
  const d = {
    name: String(e.name || '').trim(), strasse: String(e.strasse || '').trim(), hausnr: String(e.hausnr || '').trim().slice(0, 16),
    plz: String(e.plz || '').trim(), ort: String(e.ort || '').trim(), land: String(e.land || 'CH').toUpperCase(),
    iban: String(e.iban || '').replace(/\s+/g, '').toUpperCase(), email: String(e.email || '').trim().slice(0, 120),
    uid: String(e.uid || '').trim().slice(0, 30), mwst_hinweis: String(e.mwst_hinweis || '').trim().slice(0, 200), zahlungsfrist_tage: Number(e.zahlungsfrist_tage) || 30
  };
  await ensureSchema();
  const v = [d.name, d.strasse, d.hausnr, d.plz, d.ort, d.land, d.iban, d.email, d.uid, d.mwst_hinweis, d.zahlungsfrist_tage];
  const up = await pool.query(`UPDATE rechnung_einstellungen SET name=$1, strasse=$2, hausnr=$3, plz=$4, ort=$5, land=$6, iban=$7, email=$8, uid=$9, mwst_hinweis=$10, zahlungsfrist_tage=$11 WHERE id=1`, v);
  if (!up.rowCount) await pool.query(`INSERT INTO rechnung_einstellungen (id, name, strasse, hausnr, plz, ort, land, iban, email, uid, mwst_hinweis, zahlungsfrist_tage) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, v);
  return d;
}

// ── Referenz: QR-Referenz bei QR-IBAN, sonst Creditor Reference (ISO 11649) ───
function referenzFuer(iban, clientId, jahr, laufnr) {
  const k = String(clientId).padStart(8, '0').slice(-8), j = String(jahr).slice(-4), l = String(laufnr).padStart(6, '0').slice(-6);
  if (U.isQRIBAN(iban)) {
    const basis = ('0'.repeat(8) + k + j + l).slice(-26);
    return basis + U.calculateQRReferenceChecksum(basis);
  }
  const basis = j + l + k;   // 18 Ziffern
  return 'RF' + U.calculateSCORReferenceChecksum(basis) + basis;
}

// ── Rechnung anlegen ──────────────────────────────────────────────────────────
function adresseAusFreitext(text) {
  // Erwartet «Strasse Nr» und «PLZ Ort» in getrennten Zeilen (Name steht oft davor). Unsicheres bleibt leer, die Beraterin ergänzt es.
  const zeilen = String(text || '').split(/\n|,/).map(z => z.trim()).filter(Boolean);
  let plz = '', ort = '', strasse = '';
  for (const z of zeilen) {
    const m = z.match(/^(?:CH-)?(\d{4})\s+(.+)$/);
    if (m) { plz = m[1]; ort = m[2]; }
    else if (/\d/.test(z) && !strasse) strasse = z;
  }
  return { strasse, plz, ort };
}

async function legeAn({ clientId, posten, laufzeit = 'monat', betragRappen, beschreibung, empfaenger = {}, bemerkung }) {
  const p = POSTEN[posten];
  if (!p) throw Object.assign(new Error('Unbekannter Posten.'), { status: 400 });
  const lz = p.laufzeit && laufzeit === 'jahr' ? 'jahr' : 'monat';
  let betrag = Number.isInteger(betragRappen) && betragRappen > 0 ? betragRappen : betragFuer(posten, lz);
  if (!betrag || betrag < 100 || betrag > 100000000) throw Object.assign(new Error('Der Betrag fehlt oder ist ungültig.'), { status: 400 });
  const e = await holeEinstellungen();
  const fehler = pruefeEinstellungen(e);
  if (fehler.length) throw Object.assign(new Error('Die Absenderangaben sind unvollständig: ' + fehler[0]), { status: 409, einstellungenFehlen: true });
  await ensureSchema();
  const jahr = new Date().getFullYear();
  const { rows: m } = await pool.query('SELECT COALESCE(MAX(laufnr),0)::int AS n FROM rechnungen WHERE jahr=$1', [jahr]);
  const laufnr = m[0].n + 1;
  const nummer = `${jahr}-${String(laufnr).padStart(4, '0')}`;
  const referenz = referenzFuer(e.iban, clientId, jahr, laufnr);
  const faellig = new Date(Date.now() + e.zahlungsfrist_tage * 86400000);
  const emp = {
    name: String(empfaenger.name || '').trim().slice(0, 70), strasse: String(empfaenger.strasse || '').trim().slice(0, 70),
    plz: String(empfaenger.plz || '').trim().slice(0, 16), ort: String(empfaenger.ort || '').trim().slice(0, 35)
  };
  const text = (beschreibung && String(beschreibung).trim()) || (p.label + (p.laufzeit ? (lz === 'jahr' ? ', 12 Monate (Jahreszahlung, 10 Prozent Rabatt)' : ', 1 Monat') : ''));
  const { rows } = await pool.query(
    `INSERT INTO rechnungen (client_id, jahr, laufnr, nummer, posten, laufzeit, beschreibung, betrag_rappen, status, referenz, empfaenger, bemerkung, faellig_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'offen',$9,$10,$11,$12) RETURNING *`,
    [clientId, jahr, laufnr, nummer, posten, lz, text.slice(0, 300), betrag, referenz, JSON.stringify(emp), bemerkung ? String(bemerkung).slice(0, 300) : null, faellig]);
  return rows[0];
}

// ── PDF ───────────────────────────────────────────────────────────────────────
function chf(rappen) {
  const s = (Math.round(rappen) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  return s;
}
function datum(d) { const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`; }

async function pdfErzeugen(rechnung, e) {
  const PDFDocument = require('pdfkit');
  const { SwissQRBill } = require('swissqrbill/pdf');
  const emp = typeof rechnung.empfaenger === 'string' ? JSON.parse(rechnung.empfaenger || '{}') : (rechnung.empfaenger || {});
  const erg = { name: e.name, address: e.strasse, buildingNumber: e.hausnr || undefined, zip: e.plz, city: e.ort, country: e.land || 'CH' };
  const daten = {
    amount: rechnung.betrag_rappen / 100, currency: 'CHF',
    creditor: { account: e.iban, ...erg },
    reference: rechnung.referenz,
    message: `Rechnung ${rechnung.nummer}`
  };
  if (emp.name && emp.strasse && /^\d{4}$/.test(emp.plz || '') && emp.ort) {
    daten.debtor = { name: emp.name, address: emp.strasse, zip: emp.plz, city: emp.ort, country: 'CH' };
  }
  const bill = new SwissQRBill(daten);   // wirft bei ungültigen Angaben
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Rechnung ${rechnung.nummer}`, Author: e.name } });
  const teile = [];
  doc.on('data', c => teile.push(c));
  const fertig = new Promise((res, rej) => { doc.on('end', () => res(Buffer.concat(teile))); doc.on('error', rej); });

  // Absender
  doc.font('Helvetica-Bold').fontSize(12).text(e.name);
  doc.font('Helvetica').fontSize(10).text(`${e.strasse}${e.hausnr ? ' ' + e.hausnr : ''}`).text(`${e.plz} ${e.ort}`);
  if (e.email) doc.text(e.email);
  if (e.uid) doc.text(e.uid);
  // Empfänger
  doc.font('Helvetica').fontSize(11);
  const ey = 150;
  doc.text(emp.name || '', 320, ey, { width: 220 });
  if (emp.strasse) doc.text(emp.strasse, 320, doc.y, { width: 220 });
  if (emp.plz || emp.ort) doc.text(`${emp.plz || ''} ${emp.ort || ''}`.trim(), 320, doc.y, { width: 220 });
  // Titel
  doc.font('Helvetica-Bold').fontSize(16).text(`Rechnung ${rechnung.nummer}`, 56, 270);
  doc.font('Helvetica').fontSize(10).fillColor('#444')
    .text(`Datum: ${datum(rechnung.ausgestellt_am || new Date())}`, 56, doc.y + 4)
    .text(`Zahlbar bis: ${datum(rechnung.faellig_am)}`);
  doc.fillColor('#000');
  // Position
  const y0 = 340;
  doc.moveTo(56, y0).lineTo(539, y0).strokeColor('#999').stroke();
  doc.font('Helvetica-Bold').fontSize(10).text('Beschreibung', 56, y0 + 8).text('Betrag CHF', 440, y0 + 8, { width: 99, align: 'right' });
  doc.moveTo(56, y0 + 24).lineTo(539, y0 + 24).stroke();
  doc.font('Helvetica').fontSize(11).text(rechnung.beschreibung, 56, y0 + 32, { width: 370 });
  const yEnde = Math.max(doc.y, y0 + 52);
  doc.text(chf(rechnung.betrag_rappen), 440, y0 + 32, { width: 99, align: 'right' });
  doc.moveTo(56, yEnde + 8).lineTo(539, yEnde + 8).stroke();
  doc.font('Helvetica-Bold').fontSize(11).text('Total CHF', 330, yEnde + 16, { width: 100, align: 'right' }).text(chf(rechnung.betrag_rappen), 440, yEnde + 16, { width: 99, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  if (e.mwst_hinweis) doc.text(e.mwst_hinweis, 56, yEnde + 44, { width: 480 });
  if (rechnung.bemerkung) doc.text(rechnung.bemerkung, 56, doc.y + 6, { width: 480 });
  doc.fillColor('#000').fontSize(10).text('Vielen Dank. Bitte zahlen Sie mit dem Einzahlungsschein unten oder per E-Banking mit dem QR-Code.', 56, doc.y + 14, { width: 480 });
  bill.attachTo(doc);
  doc.end();
  return fertig;
}

// ── Mail mit PDF ──────────────────────────────────────────────────────────────
// art: 'rechnung' (erste Zusendung), 'erinnerung1' oder 'erinnerung2'. Gibt die Adresse zurück. Wirft Fehler mit status 400, wenn keine Adresse da ist.
async function sendeRechnung(r, { an, art = 'rechnung' } = {}) {
  const { queueEmail } = require('./emailOutbox');
  const { rows: c } = await pool.query('SELECT name, email FROM clients WHERE id=$1', [r.client_id]);
  const adresse = String(an || (c[0] && c[0].email) || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(adresse)) throw Object.assign(new Error('Für diesen Klienten ist keine gültige E-Mail-Adresse hinterlegt.'), { status: 400 });
  const e = await holeEinstellungen();
  const pdf = await pdfErzeugen(r, e);
  const betrag = `CHF ${chf(r.betrag_rappen)}`;
  let betreff, text;
  if (art === 'rechnung') {
    betreff = `Rechnung ${r.nummer}`;
    text = `Guten Tag\n\nIm Anhang erhalten Sie die Rechnung ${r.nummer} über ${betrag} für: ${r.beschreibung}.\n\n`
      + `Zahlbar bis ${datum(r.faellig_am)}. Sie können mit dem QR-Code im E-Banking oder mit dem Einzahlungsschein auf der letzten Seite der Rechnung zahlen.\n\n`
      + `Sobald die Zahlung bei mir eingegangen ist, schalte ich Ihren Zugang frei. Bei Fragen antworten Sie einfach auf diese Mail.\n\nFreundliche Grüsse\n${e.name}`;
  } else {
    betreff = `Zahlungserinnerung zur Rechnung ${r.nummer}`;
    text = `Guten Tag\n\nZur Rechnung ${r.nummer} über ${betrag} (fällig am ${datum(r.faellig_am)}) habe ich noch keinen Zahlungseingang gesehen. `
      + `Falls Sie bereits bezahlt haben, ist diese Mail gegenstandslos. Sonst finden Sie die Rechnung noch einmal im Anhang.\n\n`
      + (art === 'erinnerung2' ? `Ihr Zugang bleibt bis zum Eingang der Zahlung eingeschränkt, sobald die bezahlte Zeit abgelaufen ist.\n\n` : '')
      + `Bei Fragen antworten Sie einfach auf diese Mail.\n\nFreundliche Grüsse\n${e.name}`;
  }
  await queueEmail({ kind: 'rechnung', to: adresse, subject: betreff, text, senderName: e.name, attachments: [{ name: `Rechnung_${r.nummer}.pdf`, contentBase64: pdf.toString('base64') }] });
  if (art === 'rechnung') await pool.query('UPDATE rechnungen SET gesendet_am=NOW() WHERE id=$1', [r.id]);
  return adresse;
}

// ── Bezahlt: Abo freischalten ─────────────────────────────────────────────────
function monateDazu(basis, n) { const d = new Date(basis); d.setMonth(d.getMonth() + n); return d; }

async function alsBezahltMarkieren(id, { bezahltAm } = {}) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM rechnungen WHERE id=$1', [id]);
  const r = rows[0];
  if (!r) throw Object.assign(new Error('Rechnung nicht gefunden.'), { status: 404 });
  if (r.status === 'bezahlt') return r;
  if (r.status === 'storniert') throw Object.assign(new Error('Eine stornierte Rechnung lässt sich nicht als bezahlt markieren.'), { status: 409 });
  const p = POSTEN[r.posten] || { art: 'einmalig' };
  const am = bezahltAm ? new Date(bezahltAm) : new Date();
  await pool.query(`UPDATE rechnungen SET status='bezahlt', bezahlt_am=$2 WHERE id=$1`, [id, am]);
  if (p.art === 'paket') {
    const { rows: c } = await pool.query('SELECT bezahlt_bis FROM clients WHERE id=$1', [r.client_id]);
    const heute = new Date();
    const start = c[0] && c[0].bezahlt_bis && new Date(c[0].bezahlt_bis) > heute ? new Date(c[0].bezahlt_bis) : heute;
    const bis = monateDazu(start, r.laufzeit === 'jahr' ? 12 : 1);
    await pool.query(`UPDATE clients SET subscription_status='active', monthly_token_limit=$2, zugang_bis=NULL, bezahlt_bis=$3 WHERE id=$1`, [r.client_id, p.tokens, bis]);
  } else if (p.art === 'audit') {
    await pool.query(`UPDATE clients SET subscription_status='active', monthly_token_limit=200000, zugang_bis=NOW() + INTERVAL '30 days' WHERE id=$1`, [r.client_id]);
  } else if (p.art === 'quartalsreview') {
    await pool.query(`UPDATE clients SET quartalsreview_aktiv=true WHERE id=$1`, [r.client_id]).catch(() => {});
  }
  return (await pool.query('SELECT * FROM rechnungen WHERE id=$1', [id])).rows[0];
}

module.exports = { sendeRechnung, POSTEN, KULANZ_TAGE, betragFuer, holeEinstellungen, pruefeEinstellungen, speichereEinstellungen, referenzFuer, adresseAusFreitext, legeAn, pdfErzeugen, alsBezahltMarkieren, chf, datum };
