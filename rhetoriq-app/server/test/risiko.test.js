const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const { pool } = require('../db');
const P = require('../../public/pruefhinweise.js');
const { shares } = require('../lib/revenueShare');
const { KI_SATZ, KI_FELD } = require('../lib/kiHinweis');

let srv, a, b, tm = {};
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  for (const role of ['admin', 'editor']) tm[role] = (await pool.query('INSERT INTO client_users (client_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id', [a.id, role + '@ki.ch', role, role])).rows[0].id;
  srv = await H.startApp([
    ['/api/clients', require('../routes/kiHinweis')],
    ['/api/analyze', require('../routes/analyze')],
    ['/api/advisor', require('../routes/advisor')]
  ]);
});
test.after(async () => { await srv.close(); });

async function docxParts(token, body) {
  const r = await srv.call('POST', '/api/analyze/export-docx', { token, body, raw: true });
  assert.equal(r.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  return {
    doc: await zip.file('word/document.xml').async('string'),
    custom: zip.file('docProps/custom.xml') ? await zip.file('docProps/custom.xml').async('string') : '',
    core: await zip.file('docProps/core.xml').async('string')
  };
}

test('KI-Hinweis: Standard aus, Hauptzugang und Admin schalten selbst, Betrachter nicht, Klient liest nur das Eigene', async () => {
  const get = (id, t) => srv.call('GET', `/api/clients/${id}/ki-hinweis`, { token: t });
  const put = (id, t, v) => srv.call('PUT', `/api/clients/${id}/ki-hinweis`, { token: t, body: { kiHinweis: v } });
  const editor = H.clientToken(a.id, { clientUserId: tm.editor, clientUserRole: 'editor' });
  const admin = H.clientToken(a.id, { clientUserId: tm.admin, clientUserRole: 'admin' });
  assert.equal((await get(a.id, H.clientToken(a.id))).body.kiHinweis, false);
  assert.deepEqual((await get(a.id, H.clientToken(a.id))).body.textarten, ['website', 'linkedin', 'social', 'newsletter', 'press', 'speech']);
  assert.equal((await put(a.id, editor, true)).status, 403);
  assert.equal((await srv.call('PUT', `/api/clients/${a.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: 'ja' } })).status, 400);
  assert.equal((await put(b.id, H.clientToken(a.id), true)).status, 403);   // nicht für einen anderen Klienten
  assert.equal((await put(a.id, H.clientToken(a.id), true)).body.kiHinweis, true);   // Hauptzugang
  assert.equal((await get(a.id, H.clientToken(a.id))).body.kiHinweis, true);
  assert.equal((await put(a.id, admin, false)).body.kiHinweis, false);   // Rolle Admin
  assert.equal((await put(a.id, H.advisorToken(), true)).body.kiHinweis, true);   // Beraterin
  assert.equal((await get(a.id, H.clientToken(b.id))).status, 403);
  assert.equal((await get(b.id, H.advisorToken())).body.kiHinweis, false);
});

test('Prüfnachweis: freigegebene Texte mit Datum und Minuten, nur für Hauptzugang, Admin und Beraterin', async () => {
  await pool.query('DELETE FROM review_requests');
  await pool.query(`INSERT INTO review_requests (client_id, module_label, module_tile, original_text, status, minutes) VALUES ($1,'LinkedIn','linkedin','a','approved',8), ($1,'E-Mail','email','b','pending',NULL), ($2,'Webseite','website','c','approved',5)`, [a.id, b.id]);
  const r = await srv.call('GET', `/api/clients/${a.id}/pruefnachweis`, { token: H.clientToken(a.id) });
  assert.equal(r.status, 200);
  assert.equal(r.body.pruefungen.length, 1);
  assert.equal(r.body.pruefungen[0].textart, 'LinkedIn');
  assert.equal(r.body.pruefungen[0].minuten, 8);
  assert.ok(!JSON.stringify(r.body).includes('"a"'));   // kein Textinhalt
  assert.equal((await srv.call('GET', `/api/clients/${a.id}/pruefnachweis`, { token: H.clientToken(a.id, { clientUserId: tm.editor, clientUserRole: 'editor' }) })).status, 403);
  assert.equal((await srv.call('GET', `/api/clients/${a.id}/pruefnachweis`, { token: H.clientToken(b.id) })).status, 403);
  const csv = await srv.call('GET', `/api/clients/${a.id}/pruefnachweis?format=csv`, { token: H.advisorToken(), raw: true });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.ok(text.includes('LinkedIn') && text.includes('Geprüft am') && !text.includes('Webseite'));
});

test('Word-Export: Metadaten immer, Hinweis-Satz nur bei eingeschaltetem Schalter, öffentlicher Textart und ungeprüftem Text', async () => {
  await srv.call('PUT', `/api/clients/${b.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: false } });
  await srv.call('PUT', `/api/clients/${a.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: true } });
  const aus = await docxParts(H.clientToken(b.id), { content: 'Hallo Welt.', title: 'Test', tile: 'website' });
  assert.ok(aus.custom.includes(KI_FELD));
  assert.ok(aus.core.includes(KI_FELD));
  assert.ok(!aus.doc.includes(KI_SATZ));
  const an = await docxParts(H.clientToken(a.id), { content: 'Hallo Welt.', title: 'Test', tile: 'website' });
  assert.ok(an.doc.includes(KI_SATZ));
  assert.ok(!KI_SATZ.includes('geprüft'));   // behauptet nur die KI-Unterstützung
  for (const tile of ['website', 'linkedin', 'social', 'newsletter', 'press', 'speech'])
    assert.ok((await docxParts(H.clientToken(a.id), { content: 'x.', title: 'T', tile })).doc.includes(KI_SATZ), tile);
  // nicht öffentlich oder ohne Angabe: kein Hinweis
  for (const tile of ['email', 'brief', 'custom', undefined])
    assert.ok(!(await docxParts(H.clientToken(a.id), { content: 'x.', title: 'T', tile })).doc.includes(KI_SATZ), String(tile));
  // von der Beraterin geprüft: kein Hinweis
  assert.ok(!(await docxParts(H.clientToken(a.id), { content: 'x.', title: 'T', tile: 'website', geprueft: true })).doc.includes(KI_SATZ));
  // Beraterin mit Klienten-Nummer: Einstellung dieses Klienten
  assert.ok((await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T', tile: 'website', clientId: a.id })).doc.includes(KI_SATZ));
  assert.ok(!(await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T', tile: 'website', clientId: b.id })).doc.includes(KI_SATZ));
  assert.ok(!(await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T', tile: 'website' })).doc.includes(KI_SATZ));
  // Ein Klient kann die Einstellung eines anderen nicht über die Anfrage erzwingen
  assert.ok(!(await docxParts(H.clientToken(b.id), { content: 'Hallo.', title: 'T', tile: 'website', clientId: a.id })).doc.includes(KI_SATZ));
});

test('Prüfhilfe erkennt Zahlen, Prozente, Beträge, Daten und Eigennamen', () => {
  const r = P.find("Am 12.03.2026 stieg der Umsatz um 18 % auf CHF 1'200'000. Frau Müller und Hans Muster von der Flaga AG betreuen 250 Kunden. Wir freuen uns auf die Zusammenarbeit im Team. Die UBS prüft im März 2027.");
  assert.ok(r.daten.includes('12.03.2026') && r.daten.includes('März 2027'));
  assert.deepEqual(r.prozent, ['18 %']);
  assert.deepEqual(r.betraege, ["CHF 1'200'000"]);
  assert.ok(r.zahlen.includes('250 Kunden') || r.zahlen.includes('250'));
  assert.ok(r.namen.includes('Hans Muster') && r.namen.includes('Flaga AG') && r.namen.includes('UBS'));
  assert.ok(r.namen.some(n => /Müller/.test(n)));
  // Gewöhnliche Hauptwörter und Satzanfänge sind keine Namen
  assert.ok(!r.namen.includes('Zusammenarbeit') && !r.namen.includes('Team') && !r.namen.includes('Wir'));
  assert.equal(P.find('Wir freuen uns auf Ihre Antwort.').total, 0);
  assert.equal(P.find('').total, 0);
  assert.ok(P.summary(r).length >= 4);
});

test('Umsatzanteil: Rechnung und Flag über 40 Prozent', () => {
  const r = shares([{ clientId: 1, name: 'A', umsatzChf: 2490 }, { clientId: 2, name: 'B', umsatzChf: 590 }, { clientId: 3, name: 'C', umsatzChf: 290 }]);
  assert.equal(r.totalChf, 3370);
  assert.equal(r.klienten[0].anteilProzent, 73.9);
  assert.equal(r.klienten[0].zu_hoch, true);
  assert.equal(r.klienten[1].zu_hoch, false);
  assert.equal(r.zuHoch.length, 1);
  assert.equal(shares([]).totalChf, 0);
  assert.equal(shares([{ clientId: 1, name: 'A', umsatzChf: 100 }, { clientId: 2, name: 'B', umsatzChf: 100 }]).zuHoch.length, 2);
});

test('GET /api/advisor/revenue-share: nur Beraterin, Abo plus Mehraufwand, Enterprise bei 2490', async () => {
  await pool.query('UPDATE clients SET monthly_token_limit=$1 WHERE id=$2', [750000, a.id]); // 590
  // Nur bezahlte Abos zählen als Umsatz
  await pool.query("UPDATE clients SET subscription_status='active' WHERE id IN ($1,$2)", [a.id, b.id]);
  // b ohne Kontingent = Enterprise 2490
  const noAuth = await srv.call('GET', '/api/advisor/revenue-share', { token: H.clientToken(a.id) });
  assert.equal(noAuth.status, 403);
  const r = await srv.call('GET', '/api/advisor/revenue-share', { token: H.advisorToken() });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.body.klienten.map(k => [k.name, k]));
  assert.equal(byName['Alpha AG'].aboChf, 590);
  assert.equal(byName['Beta AG'].aboChf, 2490);
  assert.equal(byName['Beta AG'].zu_hoch, true);
  assert.equal(byName['Alpha AG'].zu_hoch, false);
  assert.equal(r.body.limitProzent, 40);
});

test('Umsatz: ohne bezahltes Abo kein Abopreis, auch ohne Kontingent kein Enterprise zu 2490', async () => {
  await pool.query("UPDATE clients SET subscription_status='trial', monthly_token_limit=NULL WHERE id=$1", [b.id]);
  const r = await srv.call('GET', '/api/advisor/revenue-share', { token: H.advisorToken() });
  const byName = Object.fromEntries(r.body.klienten.map(k => [k.name, k]));
  assert.equal(byName['Beta AG'].aboChf, null);
  assert.equal(byName['Beta AG'].umsatzChf, 0);
  const own = await pool.query("UPDATE clients SET subscription_status='active' WHERE id=$1 RETURNING id", [b.id]);
  assert.equal(own.rows.length, 1);
  const r2 = await srv.call('GET', '/api/advisor/revenue-share', { token: H.advisorToken() });
  assert.equal(Object.fromEntries(r2.body.klienten.map(k => [k.name, k]))['Beta AG'].aboChf, 2490);
});
