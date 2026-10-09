const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const { pool } = require('../db');
const P = require('../../public/pruefhinweise.js');
const { shares } = require('../lib/revenueShare');
const { KI_SATZ, KI_FELD } = require('../lib/kiHinweis');

let srv, a, b;
test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
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

test('KI-Hinweis: Standard aus, nur Beraterin schaltet, Klient liest nur das Eigene', async () => {
  const get = (id, t) => srv.call('GET', `/api/clients/${id}/ki-hinweis`, { token: t });
  assert.equal((await get(a.id, H.clientToken(a.id))).body.kiHinweis, false);
  assert.equal((await srv.call('PUT', `/api/clients/${a.id}/ki-hinweis`, { token: H.clientToken(a.id), body: { kiHinweis: true } })).status, 403);
  assert.equal((await srv.call('PUT', `/api/clients/${a.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: 'ja' } })).status, 400);
  assert.equal((await srv.call('PUT', `/api/clients/${a.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: true } })).body.kiHinweis, true);
  assert.equal((await get(a.id, H.clientToken(a.id))).body.kiHinweis, true);
  assert.equal((await get(a.id, H.clientToken(b.id))).status, 403);
  assert.equal((await get(b.id, H.advisorToken())).body.kiHinweis, false);
});

test('Word-Export: Metadaten immer, Hinweis-Satz nur bei eingeschaltetem Schalter', async () => {
  await srv.call('PUT', `/api/clients/${b.id}/ki-hinweis`, { token: H.advisorToken(), body: { kiHinweis: false } });
  const aus = await docxParts(H.clientToken(b.id), { content: 'Hallo Welt.', title: 'Test' });
  assert.ok(aus.custom.includes(KI_FELD));
  assert.ok(aus.core.includes(KI_FELD));
  assert.ok(!aus.doc.includes(KI_SATZ));
  const an = await docxParts(H.clientToken(a.id), { content: 'Hallo Welt.', title: 'Test' });
  assert.ok(an.doc.includes(KI_SATZ));
  // Beraterin mit Klienten-Nummer: Einstellung dieses Klienten
  assert.ok((await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T', clientId: a.id })).doc.includes(KI_SATZ));
  assert.ok(!(await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T', clientId: b.id })).doc.includes(KI_SATZ));
  assert.ok(!(await docxParts(H.advisorToken(), { content: 'Hallo.', title: 'T' })).doc.includes(KI_SATZ));
  // Ein Klient kann die Einstellung eines anderen nicht über die Anfrage erzwingen
  assert.ok(!(await docxParts(H.clientToken(b.id), { content: 'Hallo.', title: 'T', clientId: a.id })).doc.includes(KI_SATZ));
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
