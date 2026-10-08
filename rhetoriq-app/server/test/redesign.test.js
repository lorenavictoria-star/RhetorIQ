// Tests der neuen Redesign-Routen. Laufen gegen pg-mem und Attrappen (keine echte DB, KI oder Mail).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');

const safeFetch = require('../lib/safeFetch');
const realSafeFetchHtml = safeFetch.safeFetchHtml;
const page = { html: '', url: 'https://keller.example/' };
safeFetch.safeFetchHtml = async (u) => { if (page.fail) throw new Error('nicht erreichbar'); return { url: page.url, html: page.html, truncated: false }; };

let srv;
const A = () => H.advisorToken();

test.before(async () => {
  await H.setupBase();
  srv = await H.startApp([
    ['/api/inquiries', require('../routes/inquiries').advisorRouter],
    ['/api/onboarding-drafts', require('../routes/onboardingDrafts')]
  ]);
});
test.after(async () => { await srv.close(); });

// ── S1 Onboarding-Entwürfe ─────────────────────────────────
test('S1 Entwürfe: ohne Token 401, Klient-Token 403', async () => {
  assert.equal((await srv.call('GET', '/api/onboarding-drafts')).status, 401);
  assert.equal((await srv.call('GET', '/api/onboarding-drafts', { token: H.clientToken(1) })).status, 403);
  assert.equal((await srv.call('POST', '/api/onboarding-drafts', { body: { firma: 'X' } })).status, 401);
});

test('S1 Entwurf anlegen, lesen, ändern, löschen', async () => {
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'Keller Bau AG', kontakt: 'Anna Keller', email: 'Anna@Keller.ch', sektor: 'kmu', anrede: 'du' } });
  assert.equal(c.status, 201);
  assert.equal(c.body.status, 'workshop_offen');
  assert.equal(c.body.email, 'anna@keller.ch');
  const id = c.body.id;
  const g = await srv.call('GET', `/api/onboarding-drafts/${id}`, { token: A() });
  assert.equal(g.body.firma, 'Keller Bau AG');
  const u = await srv.call('PUT', `/api/onboarding-drafts/${id}`, { token: A(), body: { schritt: 2, module: ['Text Generator', 'Unbekannt', 'Risiko-Scan'], briefing: { blick: ['a'] } } });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body.module, ['Text Generator', 'Risiko-Scan']);
  assert.equal(u.body.schritt, 2);
  assert.equal(u.body.firma, 'Keller Bau AG');
  const l = await srv.call('GET', '/api/onboarding-drafts', { token: A() });
  assert.ok(l.body.some(d => d.id === id));
  assert.equal((await srv.call('PUT', `/api/onboarding-drafts/${id}`, { token: A(), body: { anrede: 'xx' } })).status, 400);
  assert.equal((await srv.call('DELETE', `/api/onboarding-drafts/${id}`, { token: A() })).status, 200);
  assert.equal((await srv.call('GET', `/api/onboarding-drafts/${id}`, { token: A() })).status, 404);
});

test('S1 Entwurf aus Anfrage: Vorbefüllung, Status, draft_id in Liste', async () => {
  await require('../routes/inquiries').ensureTable();
  const { rows } = await H.pool.query(`INSERT INTO inquiries (name, company, email, message) VALUES ('Bea Muster','Muster GmbH','bea@muster.ch','Hallo') RETURNING id`);
  const qid = rows[0].id;
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: qid } });
  assert.equal(c.status, 201);
  assert.equal(c.body.kontakt, 'Bea Muster');
  assert.equal(c.body.firma, 'Muster GmbH');
  assert.equal(c.body.email, 'bea@muster.ch');
  const l = await srv.call('GET', '/api/inquiries', { token: A() });
  const q = l.body.find(x => x.id === qid);
  assert.equal(q.status, 'workshop_offen');
  assert.equal(q.draft_id, c.body.id);
  assert.equal(q.name, 'Bea Muster');
  assert.equal((await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { inquiry_id: 9999 } })).status, 404);
});

// ── S2 Webseiten-Scan ──────────────────────────────────────
const SCAN_JSON = JSON.stringify({
  blick: ['Familienunternehmen im Bau (laut Webseite)'], kommunikation: ['sachlich'], hypothesen: ['menschlicher als die Webseite'],
  eroeffnung: ['Beispiel'], texte: ['Über uns'], fragen: ['Was macht Sie stolz?'],
  module: [['Text Generator', 'Alltag'], ['Erfundenes Modul', 'x'], ['Risiko-Scan', 'heikle Mitteilungen']],
  widerstaende: ['keine Zeit'], material: ['Flipchart']
});

test('S2 safeFetch: interne und unerlaubte Adressen werden abgelehnt', async () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://[::1]/',
    'http://192.168.1.1/', 'ftp://example.com/', 'https://example.com:8443/', 'http://user:pw@example.com/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd']) {
    await assert.rejects(() => realSafeFetchHtml(u), undefined, u);
  }
  assert.equal(safeFetch.isBlockedAddress('8.8.8.8'), false);
  assert.equal(safeFetch.isBlockedAddress('172.20.1.1'), true);
  assert.equal(safeFetch.isBlockedAddress('fd00::1'), true);
});

test('S2 Scan: Erfolg speichert Vorschläge und Briefing, filtert unbekannte Module', async () => {
  page.html = '<html><head><title>Keller Bau</title></head><body><p>' + 'Wir bauen Häuser und Gewerbebauten in der Region. '.repeat(10) + '</p></body></html>';
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'Keller Bau AG', kontakt: 'Anna Keller', webseite: 'keller.example', sektor: 'kmu' } });
  H.ai.reply = 'Hier ist das Ergebnis:\n```json\n' + SCAN_JSON + '\n```';
  H.ai.calls.length = 0;
  const r = await srv.call('POST', `/api/onboarding-drafts/${c.body.id}/scan`, { token: A() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vorschlaege.module.map(m => m[0]), ['Text Generator', 'Risiko-Scan']);
  assert.match(H.ai.calls[0].system, /Hypothesen/);
  const g = await srv.call('GET', `/api/onboarding-drafts/${c.body.id}`, { token: A() });
  assert.deepEqual(g.body.briefing.blick, ['Familienunternehmen im Bau (laut Webseite)']);
  assert.equal(g.body.vorschlaege.fragen.length, 1);
});

test('S2 Scan: Fehlerfälle (kein Webseitenfeld, Abruf, KI, unlesbare Antwort), Rechte', async () => {
  const noUrl = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'Ohne Web' } });
  assert.equal((await srv.call('POST', `/api/onboarding-drafts/${noUrl.body.id}/scan`, { token: A() })).status, 400);
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'F', webseite: 'f.example' } });
  const url = `/api/onboarding-drafts/${c.body.id}/scan`;
  page.fail = true;
  assert.equal((await srv.call('POST', url, { token: A() })).status, 422);
  page.fail = false;
  H.ai.reply = 'keine Ahnung';
  const bad = await srv.call('POST', url, { token: A() });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /nicht lesbar/);
  H.ai.fail = true;
  assert.equal((await srv.call('POST', url, { token: A() })).status, 502);
  H.ai.fail = false;
  assert.equal((await srv.call('POST', url)).status, 401);
  assert.equal((await srv.call('POST', url, { token: H.clientToken(1) })).status, 403);
  assert.equal((await srv.call('POST', '/api/onboarding-drafts/9999/scan', { token: A() })).status, 404);
});

// ── S3 Workshop-Mappe ──────────────────────────────────────
test('S3 Workshop-Mappe: vier gültige DOCX im Ordner workshop, Rechte', async () => {
  const JSZip = require('jszip');
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: {
    firma: 'Keller Bau AG', kontakt: 'Anna Keller', sektor: 'kmu', workshop_datum: '14. Oktober 2026',
    module: ['Text Generator', 'Risiko-Scan'], briefing: { blick: ['Punkt eins'], module: [['Text Generator', 'Alltag']], fragen: ['Frage?'] } } });
  const id = c.body.id;
  const url = `/api/onboarding-drafts/${id}/workshop-docs`;
  assert.equal((await srv.call('POST', url)).status, 401);
  assert.equal((await srv.call('POST', url, { token: H.clientToken(1) })).status, 403);
  const r = await srv.call('POST', url, { token: A(), body: { branche: 'Bau und Handwerk' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files.map(f => f.name), [
    '0_Briefing_Keller_Bau_AG.docx', '1_Einfuehrungsgespraech_Keller_Bau_AG.docx', '2_Workshop_Leitfaden_Keller_Bau_AG.docx', '3_Erfassungsbogen_Keller_Bau_AG.docx']);
  assert.ok(r.body.files.every(f => f.folder === 'workshop' && f.draft_id === id && f.client_id === null && f.size > 5000));
  const { rows } = await H.pool.query('SELECT name, data FROM client_files WHERE draft_id=$1 ORDER BY name', [id]);
  assert.equal(rows.length, 4);
  for (const f of rows) {
    const zip = await JSZip.loadAsync(f.data);
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes('<w:body>'), f.name);
  }
  const intro = await JSZip.loadAsync(rows.find(x => x.name.startsWith('1_')).data);
  const ixml = await intro.file('word/document.xml').async('string');
  assert.ok(ixml.includes('Datum: 14. Oktober 2026'));
  assert.ok(ixml.includes('[✓] Risiko-Scan') && ixml.includes('[✓] Brand Voice'));
  assert.ok(!ixml.includes('Hotellerie / Tourismus'));
  // erneutes Erzeugen ersetzt die Dateien, keine Duplikate
  await srv.call('POST', url, { token: A() });
  const n = await H.pool.query('SELECT COUNT(*)::int AS n FROM client_files WHERE draft_id=$1', [id]);
  assert.equal(n.rows[0].n, 4);
  assert.equal((await srv.call('POST', '/api/onboarding-drafts/9999/workshop-docs', { token: A() })).status, 404);
});
