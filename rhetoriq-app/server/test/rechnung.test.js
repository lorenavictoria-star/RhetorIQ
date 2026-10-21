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
  assert.equal(Number(c.monthly_token_limit), 2000000); assert.equal(c.subscription_status, 'active');
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
  assert.equal(Number((await row()).monthly_token_limit), 750000, 'Kontingent des neuen Pakets');
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
