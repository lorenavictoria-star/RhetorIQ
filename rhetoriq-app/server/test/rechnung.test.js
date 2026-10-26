// Rechnung per Überweisung: Absenderangaben, QR-Referenz, PDF mit Einzahlungsschein, Freischaltung bei «bezahlt», Ablauf mit Kulanz.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = H;
const U = require('swissqrbill/utils');

process.env.ABO_PFLICHT_AB = '2026-01-01T00:00:00Z';
let srv, a, b, tm = {};
const adv = () => H.advisorToken();
const call = (m, u, o) => srv.call(m, u, o);
const EINST = { name: 'Lorena Lienhard', strasse: 'Musterstrasse', hausnr: '7', plz: '3000', ort: 'Bern', land: 'CH', iban: 'CH93 0076 2011 6238 5295 7', email: 'contact@lorenalienhard.ch', uid: '', mwst_hinweis: 'Nicht mehrwertsteuerpflichtig.', zahlungsfrist_tage: 30 };
const QRIBAN = 'CH44 3199 9123 0008 8901 2';

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN address TEXT').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit BIGINT').catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN quartalsreview_aktiv BOOLEAN').catch(() => {});
  a = await H.addClient('Rechnung AG'); b = await H.addClient('Fremd AG');
  await pool.query(`UPDATE clients SET address=$2, email='kunde@firma.ch' WHERE id=$1`, [a.id, 'Rechnung AG\nBahnhofstrasse 12\n8001 Zürich']);
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  for (const role of ['admin', 'editor']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@k.ch', role, role])).rows[0].id;
  await require('../lib/schemaRedesign').ensureSchema();
  srv = await H.startApp([['/api/rechnungen', require('../routes/rechnungen')]]);
});
test.after(async () => { await srv.close(); });

test('Absenderangaben: nur Beraterin, IBAN wird geprüft, ohne Angaben keine Rechnung', async () => {
  const tok = H.clientToken(a.id, { clientUserId: tm.admin, clientUserRole: 'admin' });
  assert.ok([401, 403].includes((await call('GET', '/api/rechnungen/einstellungen', { token: tok })).status));
  let r = await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'business' } });
  assert.equal(r.status, 409); assert.equal(r.body.einstellungenFehlen, true);
  assert.equal((await call('PUT', '/api/rechnungen/einstellungen', { token: adv(), body: { ...EINST, iban: 'CH00 0000 0000 0000 0000 0' } })).status, 400);
  assert.equal((await call('PUT', '/api/rechnungen/einstellungen', { token: adv(), body: { ...EINST, iban: 'DE89 3704 0044 0532 0130 00' } })).status, 400, 'nur Schweizer IBAN');
  r = await call('PUT', '/api/rechnungen/einstellungen', { token: adv(), body: EINST });
  assert.equal(r.status, 200); assert.equal(r.body.vollstaendig, true);
  assert.equal((await call('GET', '/api/rechnungen/einstellungen', { token: adv() })).body.einstellungen.iban, 'CH9300762011623852957');
});

test('Referenz: gültige Creditor Reference bei normaler IBAN, gültige QR-Referenz bei QR-IBAN', () => {
  const R = require('../lib/rechnung');
  const scor = R.referenzFuer('CH9300762011623852957', 12, 2026, 7);
  assert.ok(U.isSCORReferenceValid(scor), scor);
  const qrr = R.referenzFuer('CH4431999123000889012', 12, 2026, 7);
  assert.equal(qrr.length, 27); assert.ok(U.isQRReferenceValid(qrr), qrr);
  assert.notEqual(R.referenzFuer('CH9300762011623852957', 12, 2026, 8), scor);
});

test('Rechnung erstellen: Betrag aus dem Paket, Jahrespreis mit 10 Prozent Rabatt, laufende Nummer, Vorschlag aus der Adresse', async () => {
  const v = await call('GET', `/api/rechnungen/client/${a.id}/vorschlag`, { token: adv() });
  assert.equal(v.body.empfaenger.strasse, 'Bahnhofstrasse 12'); assert.equal(v.body.empfaenger.plz, '8001'); assert.equal(v.body.empfaenger.ort, 'Zürich');
  const emp = { name: 'Rechnung AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  const r1 = await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'business', laufzeit: 'monat', empfaenger: emp } });
  assert.equal(r1.status, 200); assert.equal(r1.body.rechnung.betragRappen, 149000); assert.match(r1.body.rechnung.nummer, /^\d{4}-0001$/);
  const r2 = await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'team', laufzeit: 'jahr', empfaenger: emp } });
  assert.equal(r2.body.rechnung.betragRappen, Math.round(59000 * 12 * 0.9)); assert.match(r2.body.rechnung.nummer, /-0002$/);
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'unbekannt' } })).status, 400);
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'andere', betragRappen: 5 } })).status, 400, 'zu kleiner Betrag');
});

test('PDF: echtes PDF mit QR-Einzahlungsschein, auch mit QR-IBAN; Klient lädt nur die eigene Rechnung', async () => {
  const tok = H.clientToken(a.id, { clientUserId: tm.admin, clientUserRole: 'admin' });
  const liste = await call('GET', `/api/rechnungen/client/${a.id}`, { token: tok });
  assert.equal(liste.status, 200); assert.equal(liste.body.rechnungen.length, 2);
  const id = liste.body.rechnungen.find(r => r.betragRappen === 149000).id;
  const R = require('../lib/rechnung');
  const row = (await pool.query('SELECT * FROM rechnungen WHERE id=$1', [id])).rows[0];
  const pdf = await R.pdfErzeugen(row, { ...EINST, iban: 'CH9300762011623852957' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > 5000);
  const qrRow = { ...row, referenz: R.referenzFuer('CH4431999123000889012', a.id, 2026, 1) };
  const pdf2 = await R.pdfErzeugen(qrRow, { ...EINST, iban: 'CH4431999123000889012' });
  assert.equal(pdf2.subarray(0, 5).toString(), '%PDF-');
  // Rechnung eines anderen Klienten: nicht abrufbar
  const fremd = await call('GET', `/api/rechnungen/client/${b.id}/${id}/pdf`, { token: adv() });
  assert.equal(fremd.status, 404);
});

test('Senden: Mail mit PDF-Anhang in der Warteschlange, Zeitstempel gesetzt', async () => {
  const id = (await pool.query(`SELECT id FROM rechnungen WHERE betrag_rappen=149000`)).rows[0].id;
  const r = await call('POST', `/api/rechnungen/client/${a.id}/${id}/senden`, { token: adv(), body: {} });
  assert.equal(r.status, 200); assert.equal(r.body.an, 'kunde@firma.ch');
  const m = H.mails.find(x => x.kind === 'rechnung');
  assert.match(m.subject, /^Rechnung \d{4}-0001$/);
  assert.equal(m.to, 'kunde@firma.ch');
  assert.match(m.text, /QR-Code/);
  assert.equal(Buffer.from(m.attachments[0].contentBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.ok((await pool.query('SELECT gesendet_am FROM rechnungen WHERE id=$1', [id])).rows[0].gesendet_am);
});

test('Bezahlt: Abo wird aktiv mit Kontingent und bezahlt_bis; nach Ablauf plus Kulanz gesperrt; Verlängerung und Stripe heben die Frist auf', async () => {
  const abo = require('../lib/abo');
  const id = (await pool.query(`SELECT id FROM rechnungen WHERE betrag_rappen=149000`)).rows[0].id;
  const r = await call('POST', `/api/rechnungen/client/${a.id}/${id}/bezahlt`, { token: adv(), body: {} });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'active'); assert.ok(r.body.bezahltBis);
  const row = async () => (await pool.query('SELECT * FROM clients WHERE id=$1', [a.id])).rows[0];
  let c = await row();
  assert.equal(Number(c.monthly_token_limit), 2500000); assert.equal(c.subscription_status, 'active');
  assert.equal(abo.zugang(c, {}).ok, true);
  // Ende der bezahlten Zeit überschritten: erst nach der Kulanz gesperrt
  const tage = (n) => new Date(Date.now() - n * 86400000);
  await pool.query('UPDATE clients SET bezahlt_bis=$2 WHERE id=$1', [a.id, tage(5)]);
  assert.equal(abo.zugang(await row(), {}).ok, true, 'innerhalb der Kulanz');
  await pool.query('UPDATE clients SET bezahlt_bis=$2 WHERE id=$1', [a.id, tage(11)]);
  const z = abo.zugang(await row(), {});
  assert.equal(z.ok, false); assert.equal(z.grund, 'rechnung_offen');
  assert.equal(abo.zugang(await row(), { advisor: true }).ok, true, 'Beraterin ausgenommen');
  // Stripe-Klient ohne bezahlt_bis bleibt unberührt
  await pool.query('UPDATE clients SET bezahlt_bis=NULL WHERE id=$1', [a.id]);
  assert.equal(abo.zugang(await row(), {}).ok, true);
  // zweite Zahlung verlängert ab dem Ende der bezahlten Zeit
  const r2 = (await pool.query(`SELECT id FROM rechnungen WHERE betrag_rappen<>149000`)).rows[0].id;
  const bis0 = new Date(Date.now() + 10 * 86400000);
  await pool.query('UPDATE clients SET bezahlt_bis=$2 WHERE id=$1', [a.id, bis0]);
  await call('POST', `/api/rechnungen/client/${a.id}/${r2}/bezahlt`, { token: adv(), body: {} });
  const bis1 = new Date((await row()).bezahlt_bis);
  assert.ok(bis1 > new Date(bis0.getTime() + 300 * 86400000), 'Jahresrechnung verlängert um 12 Monate');
  assert.equal(Number((await row()).monthly_token_limit), 1000000, 'Kontingent des neuen Pakets');
});

test('Storno nur bei offenen Rechnungen; bezahlte bleiben', async () => {
  const emp = { name: 'Rechnung AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  const n = await call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'stimme', empfaenger: emp } });
  const id = n.body.rechnung.id;
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}/${id}/storno`, { token: adv() })).status, 200);
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}/${id}/bezahlt`, { token: adv(), body: {} })).status, 409, 'storniert, nicht bezahlbar');
  const bez = (await pool.query(`SELECT id FROM rechnungen WHERE status='bezahlt' LIMIT 1`)).rows[0].id;
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}/${bez}/storno`, { token: adv() })).status, 409);
});

// ── Automatik: Bankdatei, neue Rechnungen, Erinnerungen ───────────────────────
const RA = require('../lib/rechnungAuto');
const camt = require('../lib/camt');
const camtXml = (eintraege) => `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.04"><BkToCstmrDbtCdtNtfctn><Ntfctn>`
  + eintraege.map(e => `<Ntry><Amt Ccy="${e.w || 'CHF'}">${(e.betrag / 100).toFixed(2)}</Amt><CdtDbtInd>${e.art || 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.datum || '2026-10-22'}</Dt></BookgDt>`
    + `<NtryDtls><TxDtls><AmtDtls><TxAmt><Amt Ccy="${e.w || 'CHF'}">${(e.betrag / 100).toFixed(2)}</Amt></TxAmt></AmtDtls><RltdPties><Dbtr><Nm>Muster AG</Nm></Dbtr></RltdPties>`
    + `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>${e.ref.length === 27 ? 'QRR' : 'SCOR'}</Prtry></CdOrPrtry></Tp><Ref>${e.ref}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('')
  + `</Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`;

test('Bankdatei: Gutschriften mit Referenz werden gelesen, Belastungen, Stornos und gefährliche Dateien nicht', () => {
  const xml = camtXml([{ ref: 'RF31202600010000012', betrag: 149000 }, { ref: 'RF00', betrag: 500, art: 'DBIT' }]);
  const e = camt.lies(xml);
  assert.equal(e.length, 1); assert.equal(e[0].referenz, 'RF31202600010000012'); assert.equal(e[0].betragRappen, 149000); assert.equal(e[0].datum, '2026-10-22'); assert.equal(e[0].zahler, 'Muster AG');
  assert.throws(() => camt.lies('<!DOCTYPE x [<!ENTITY a "b">]><Ntry></Ntry>'), /DOCTYPE|ENTITY/);
  assert.throws(() => camt.lies('hallo'), /keine camt/);
  assert.throws(() => camt.lies(''), /leer/);
  // Namespace-Vorsätze (ns2:) werden toleriert
  const ns = camtXml([{ ref: 'RF31202600010000012', betrag: 100 }]).replace(/<(\/?)(Ntry|Amt|CdtDbtInd|BookgDt|Dt|NtryDtls|TxDtls|Ref|CdtrRefInf|Strd|RmtInf)\b/g, '<$1ns2:$2');
  assert.equal(camt.lies(ns).length, 1);
});

test('Zahlungsabgleich: passende Zahlung schaltet frei und bestätigt, falscher Betrag, unbekannte Referenz und doppelte Datei ändern nichts', async () => {
  const emp = { name: 'Rechnung AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  const n = await call('POST', `/api/rechnungen/client/${b.id}`, { token: adv(), body: { posten: 'team', empfaenger: emp } });
  const rec = (await pool.query('SELECT * FROM rechnungen WHERE id=$1', [n.body.rechnung.id])).rows[0];
  await pool.query(`UPDATE clients SET email='fremd@firma.ch' WHERE id=$1`, [b.id]);
  const vorher = H.mails.length;
  // falscher Betrag
  let r = await call('POST', '/api/rechnungen/zahlungen', { token: adv(), body: { xml: camtXml([{ ref: rec.referenz, betrag: 50000 }]) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.abweichend.length, 1); assert.equal(r.body.bezahlt.length, 0);
  // unbekannte Referenz
  r = await call('POST', '/api/rechnungen/zahlungen', { token: adv(), body: { xml: camtXml([{ ref: 'RF1234567890', betrag: 59000 }]) } });
  assert.equal(r.body.unbekannt.length, 1);
  assert.equal((await pool.query('SELECT status FROM rechnungen WHERE id=$1', [rec.id])).rows[0].status, 'offen');
  // richtige Zahlung, Referenz mit Leerzeichen
  const mitLeer = rec.referenz.replace(/(.{4})/g, '$1 ');
  r = await call('POST', '/api/rechnungen/zahlungen', { token: adv(), body: { xml: camtXml([{ ref: mitLeer, betrag: 59000, datum: '2026-10-20' }]) } });
  assert.equal(r.body.bezahlt.length, 1);
  const c = (await pool.query('SELECT * FROM clients WHERE id=$1', [b.id])).rows[0];
  assert.equal(c.subscription_status, 'active'); assert.equal(Number(c.monthly_token_limit), 1000000); assert.ok(c.bezahlt_bis);
  assert.ok(H.mails.slice(vorher).some(m => m.to === 'fremd@firma.ch' && /Zahlung zur Rechnung/.test(m.subject)), 'Bestätigung an den Klienten');
  // dieselbe Datei noch einmal: nichts doppelt
  r = await call('POST', '/api/rechnungen/zahlungen', { token: adv(), body: { xml: camtXml([{ ref: rec.referenz, betrag: 59000 }]) } });
  assert.equal(r.body.bezahlt.length, 0); assert.equal(r.body.bereitsBezahlt.length, 1);
  assert.equal((await call('POST', '/api/rechnungen/zahlungen', { token: adv(), body: { xml: 'kein xml' } })).status, 400);
});

test('Automatik: nur mit aktivem Abo und früherer Zahlung, nur kurz vor Ablauf, nicht doppelt; Erinnerungen nach 7 und 21 Tagen je einmal', async () => {
  const emp = { name: 'Rechnung AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  const cfg = await call('PUT', `/api/rechnungen/client/${b.id}/auto`, { token: adv(), body: { aktiv: true, posten: 'team', laufzeit: 'monat', empfaenger: emp } });
  assert.equal(cfg.status, 200); assert.equal(cfg.body.auto.aktiv, true);
  assert.equal((await call('PUT', `/api/rechnungen/client/${b.id}/auto`, { token: adv(), body: { aktiv: true, posten: 'stimm-audit' } })).status, 400, 'nur Pakete');
  const jetzt = new Date();
  // bezahlt_bis liegt (nach dem Test oben) rund einen Monat in der Zukunft: noch keine neue Rechnung
  assert.equal((await RA.neueRechnungen(jetzt)).length, 0);
  // kurz vor Ablauf (10 Tage): Rechnung wird erstellt, gesendet und als automatisch markiert
  await pool.query('UPDATE clients SET bezahlt_bis=$2 WHERE id=$1', [b.id, new Date(jetzt.getTime() + 10 * 86400000)]);
  const vorher = H.mails.length;
  const neu = await RA.neueRechnungen(jetzt);
  assert.equal(neu.length, 1); assert.equal(neu[0].gesendet, true); assert.equal(neu[0].betragRappen, 59000);
  assert.ok(H.mails.slice(vorher).some(m => m.to === 'fremd@firma.ch' && /^Rechnung /.test(m.subject)));
  assert.equal((await pool.query(`SELECT auto FROM rechnungen WHERE nummer=$1`, [neu[0].nummer])).rows[0].auto, true);
  // solange eine offene Rechnung existiert: keine weitere
  assert.equal((await RA.neueRechnungen(jetzt)).length, 0);
  // Erinnerung 1 nach 7 Tagen, Erinnerung 2 nach 21 Tagen, jeweils nur einmal
  const faellig = (await pool.query('SELECT faellig_am FROM rechnungen WHERE nummer=$1', [neu[0].nummer])).rows[0].faellig_am;
  assert.equal((await RA.erinnerungen(new Date(new Date(faellig).getTime() + 3 * 86400000))).length, 0);
  const e1 = await RA.erinnerungen(new Date(new Date(faellig).getTime() + 8 * 86400000));
  assert.equal(e1.length, 1); assert.equal(e1[0].stufe, 1);
  assert.equal((await RA.erinnerungen(new Date(new Date(faellig).getTime() + 9 * 86400000))).length, 0, 'nicht doppelt');
  const e2 = await RA.erinnerungen(new Date(new Date(faellig).getTime() + 22 * 86400000));
  assert.equal(e2.length, 1); assert.equal(e2[0].stufe, 2);
  assert.ok(H.mails.some(m => /Zahlungserinnerung/.test(m.subject)));
  // Abo ausgeschaltet: keine Rechnung mehr
  await call('PUT', `/api/rechnungen/client/${b.id}/auto`, { token: adv(), body: { aktiv: false, posten: 'team', laufzeit: 'monat', empfaenger: emp } });
  await pool.query(`UPDATE rechnungen SET status='bezahlt' WHERE client_id=$1`, [b.id]);
  await pool.query('UPDATE clients SET bezahlt_bis=$2 WHERE id=$1', [b.id, new Date(jetzt.getTime() + 2 * 86400000)]);
  assert.equal((await RA.neueRechnungen(jetzt)).length, 0);
});

test('Wochenbericht: wer bezahlt hat, wer noch offen ist, bis wann bezahlt ist', async () => {
  const jetzt = new Date();
  const emp = { name: 'Bericht AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  const c = await H.addClient('Bericht AG');
  const n1 = (await call('POST', `/api/rechnungen/client/${c.id}`, { token: adv(), body: { posten: 'stimme', empfaenger: emp } })).body.rechnung;
  const n2 = (await call('POST', `/api/rechnungen/client/${c.id}`, { token: adv(), body: { posten: 'team', empfaenger: emp } })).body.rechnung;
  await call('POST', `/api/rechnungen/client/${c.id}/${n1.id}/bezahlt`, { token: adv(), body: {} });
  await pool.query('UPDATE rechnungen SET faellig_am=$2 WHERE id=$1', [n2.id, new Date(jetzt.getTime() - 5 * 86400000)]);
  const z = (await RA.wochenzeilen(jetzt)).join('\n');
  assert.match(z, /Bezahlt in den letzten 7 Tagen:[\s\S]*\+ Bericht AG: Rechnung \d{4}-\d{4}, CHF 190\.00/);
  assert.match(z, /Noch offen:[\s\S]*- Bericht AG: Rechnung \d{4}-\d{4}, CHF 590\.00, ÜBERFÄLLIG seit 5 Tagen/);
  assert.match(z, /Bezahlt bis \(Kunden mit Rechnung\):[\s\S]*- Bericht AG: \d{2}\.\d{2}\.\d{4}/);
});

test('Monatsablage: ZIP mit Rechnungen und Zahlungen eines Monats, Vormonat, Grenzen', async () => {
  const ex = require('../lib/rechnungExport');
  assert.equal(ex.vormonat(new Date('2026-11-01T08:00:00Z')), '2026-10');
  assert.equal(ex.vormonat(new Date('2027-01-01T08:00:00Z')), '2026-12');
  assert.equal(ex.grenzen('2026-13'), null);
  const z = await ex.monatsZip('2000-01');
  assert.equal(z.ausgestellt, 0);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(z.buffer);
  assert.ok(zip.file('Rechnungen_2000-01.csv') && zip.file('Zahlungseingaenge_2000-01.csv'));
  await assert.rejects(() => ex.monatsZip('Mist'), /Ungültiger Monat/);
});

test('Monatsablage per E-Mail: eine Mail mit ZIP-Anhang an die Beraterin', async () => {
  const ex = require('../lib/rechnungExport');
  const vorher = H.mails.length;
  const r = await ex.sendeMonatsablage('2000-02');
  assert.equal(r.gesendet, true);
  const m = H.mails[H.mails.length - 1];
  assert.equal(H.mails.length, vorher + 1);
  assert.equal(m.kind, 'rechnungen_monat');
  assert.match(m.subject, /Rechnungen 2000-02 zur Ablage/);
  assert.equal(m.attachments[0].name, 'Rechnungen_2000-02.zip');
  assert.ok(m.attachments[0].contentBase64.length > 50);
});

test('Projekt-Paket: Monate und Texte pro Monat, Zugang auf Zeit bei «bezahlt», Teilrechnung ohne Zugang', async () => {
  const emp = { name: 'Rechnung AG', strasse: 'Bahnhofstrasse 12', plz: '8001', ort: 'Zürich' };
  await pool.query(`UPDATE clients SET subscription_status='trial', monthly_token_limit=200000, bezahlt_bis=NULL WHERE id=$1`, [a.id]);
  const neu = (body) => call('POST', `/api/rechnungen/client/${a.id}`, { token: adv(), body: { posten: 'projekt', empfaenger: emp, ...body } });
  // Prüfungen
  assert.equal((await neu({ betragRappen: 500000, monate: 13, texteProMonat: 100 })).status, 400, 'höchstens 12 Monate');
  assert.equal((await neu({ betragRappen: 500000, monate: 3 })).status, 400, 'Texte pro Monat fehlen');
  assert.equal((await neu({ monate: 3, texteProMonat: 100 })).status, 400, 'Betrag fehlt');
  // Rate 1: 3 Monate mit 100 Texten pro Monat
  const r1 = await neu({ betragRappen: 475000, monate: 3, texteProMonat: 100 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.rechnung.monate, 3); assert.equal(r1.body.rechnung.texteProMonat, 100);
  assert.match(r1.body.rechnung.beschreibung, /3 Monate Plattformzugang mit 100 Texten pro Monat/);
  let c = (await pool.query('SELECT subscription_status, monthly_token_limit, bezahlt_bis FROM clients WHERE id=$1', [a.id])).rows[0];
  assert.equal(c.subscription_status, 'trial', 'offene Rechnung schaltet nichts frei');
  assert.equal((await call('POST', `/api/rechnungen/client/${a.id}/${r1.body.rechnung.id}/bezahlt`, { token: adv(), body: {} })).status, 200);
  c = (await pool.query('SELECT subscription_status, monthly_token_limit, bezahlt_bis FROM clients WHERE id=$1', [a.id])).rows[0];
  assert.equal(c.subscription_status, 'active');
  assert.equal(Number(c.monthly_token_limit), 500000, '100 Texte × 5000 Tokens');
  const tage = Math.round((new Date(c.bezahlt_bis) - new Date()) / 86400000);
  assert.ok(tage >= 88 && tage <= 93, 'etwa 3 Monate, war ' + tage);
  const bis1 = new Date(c.bezahlt_bis).getTime();
  // Rate 2 ohne Zugang (0 Monate): Zugang und Kontingent bleiben
  const r2 = await neu({ betragRappen: 475000, monate: 0 });
  assert.equal(r2.status, 200); assert.equal(r2.body.rechnung.monate, 0);
  await call('POST', `/api/rechnungen/client/${a.id}/${r2.body.rechnung.id}/bezahlt`, { token: adv(), body: {} });
  c = (await pool.query('SELECT monthly_token_limit, bezahlt_bis FROM clients WHERE id=$1', [a.id])).rows[0];
  assert.equal(Number(c.monthly_token_limit), 500000); assert.equal(new Date(c.bezahlt_bis).getTime(), bis1);
  // Verlängerung: weitere 2 Monate schliessen an das bisherige Ende an
  const r3 = await neu({ betragRappen: 100000, monate: 2, texteProMonat: 60 });
  await call('POST', `/api/rechnungen/client/${a.id}/${r3.body.rechnung.id}/bezahlt`, { token: adv(), body: {} });
  c = (await pool.query('SELECT monthly_token_limit, bezahlt_bis FROM clients WHERE id=$1', [a.id])).rows[0];
  assert.equal(Number(c.monthly_token_limit), 300000);
  assert.ok(new Date(c.bezahlt_bis) > new Date(bis1 + 55 * 86400000), 'schliesst an das Ende der bisherigen Zeit an');
  // Liste der Posten kennt das Projekt-Paket
  const po = (await call('GET', '/api/rechnungen/posten', { token: adv() })).body.posten.find(p => p.key === 'projekt');
  assert.ok(po && po.projekt === true && po.freitext === true);
});
