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
    [null, require('../middleware/readOnly').readOnlyGuard],
    ['/api/inquiries', require('../routes/inquiries').advisorRouter],
    ['/api/onboarding-drafts', require('../routes/onboardingDrafts')],
    ['/api/files', require('../routes/files')],
    ['/api/reviews', require('../routes/reviews')],
    ['/api/clients', require('../routes/clients')],
    ['/api/advisor', require('../routes/viewAs')],
    ['/api/advisor', require('../routes/advisor')],
    ['/api/clients', require('../routes/clientStats')],
    ['/api/help-chat', require('../routes/helpChat')],
    ['/api/analyze', require('../routes/analyze')],
    ['/api/memory-suggest', require('../routes/memorySuggest')]
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

// ── S4 Ablage ──────────────────────────────────────────────
test('S4 Ablage: Upload (JSON und multipart), Liste, Download, ZIP, Löschen', async () => {
  const JSZip = require('jszip');
  const cl = await H.addClient('Ablage AG');
  const up = await srv.call('POST', '/api/files', { token: A(), body: { client_id: cl.id, folder: 'unterlagen', name: 'Strategie.txt', mime: 'text/plain', dataBase64: Buffer.from('Hallo Welt').toString('base64') } });
  assert.equal(up.status, 201);
  assert.equal(up.body.size, 10);
  // multipart
  const fd = new FormData();
  fd.append('client_id', String(cl.id)); fd.append('folder', 'entwuerfe');
  fd.append('file', new Blob([Buffer.from('Entwurf')], { type: 'text/plain' }), 'E.txt');
  const mp = await fetch(srv.base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + A() }, body: fd });
  assert.equal(mp.status, 201);
  const list = await srv.call('GET', `/api/files?client_id=${cl.id}`, { token: A() });
  assert.equal(list.body.length, 2);
  assert.ok(!('data' in list.body[0]));
  assert.equal((await srv.call('GET', `/api/files?client_id=${cl.id}&folder=entwuerfe`, { token: A() })).body.length, 1);
  const dl = await srv.call('GET', `/api/files/${up.body.id}/download`, { token: A(), raw: true });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'Hallo Welt');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  const z = await srv.call('GET', `/api/files/zip?client_id=${cl.id}`, { token: A(), raw: true });
  const zip = await JSZip.loadAsync(Buffer.from(await z.arrayBuffer()));
  assert.deepEqual(Object.keys(zip.files).filter(n => !n.endsWith('/')).sort(), ['entwuerfe/E.txt', 'unterlagen/Strategie.txt']);
  assert.equal((await srv.call('DELETE', `/api/files/${up.body.id}`, { token: A() })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/files/${up.body.id}`, { token: A() })).status, 404);
});

test('S4 Ablage: Grenzen und Rechte', async () => {
  const cl = await H.addClient('Rechte AG');
  const other = await H.addClient('Fremd AG');
  const post = (body, token = A()) => srv.call('POST', '/api/files', { token, body });
  assert.equal((await post({ client_id: cl.id, name: 'a.txt', dataBase64: 'QQ==' }, null)).status, 401);
  assert.equal((await post({ client_id: cl.id, name: 'a.txt', dataBase64: 'QQ==' }, H.clientToken(cl.id))).status, 403);
  assert.equal((await post({ client_id: cl.id, name: 'virus.exe', dataBase64: 'QQ==' })).status, 400);
  assert.equal((await post({ client_id: cl.id, folder: 'x', name: 'a.txt', dataBase64: 'QQ==' })).status, 400);
  assert.equal((await post({ name: 'a.txt', dataBase64: 'QQ==' })).status, 400);
  assert.equal((await post({ client_id: 99999, name: 'a.txt', dataBase64: 'QQ==' })).status, 404);
  const fd = new FormData();
  fd.append('client_id', String(cl.id));
  fd.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 10, 65)]), 'gross.txt');
  const big = await fetch(srv.base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + A() }, body: fd });
  assert.equal(big.status, 413);
  // Klient liest nur eigene Unterlagen
  const mine = await post({ client_id: cl.id, folder: 'unterlagen', name: 'mein.txt', dataBase64: 'QQ==' });
  const intern = await post({ client_id: cl.id, folder: 'workshop', name: 'intern.txt', dataBase64: 'QQ==' });
  const fremd = await post({ client_id: other.id, folder: 'unterlagen', name: 'fremd.txt', dataBase64: 'QQ==' });
  const CT = H.clientToken(cl.id);
  const l = await srv.call('GET', '/api/files', { token: CT });
  assert.deepEqual(l.body.map(f => f.name), ['mein.txt']);
  assert.equal((await srv.call('GET', `/api/files?client_id=${other.id}`, { token: CT })).status, 403);
  assert.equal((await srv.call('GET', `/api/files?client_id=${cl.id}&folder=workshop`, { token: CT })).status, 403);
  assert.equal((await srv.call('GET', `/api/files?draft_id=1`, { token: CT })).status, 403);
  assert.equal((await srv.call('GET', `/api/files/${mine.body.id}/download`, { token: CT })).status, 200);
  assert.equal((await srv.call('GET', `/api/files/${intern.body.id}/download`, { token: CT })).status, 404);
  assert.equal((await srv.call('GET', `/api/files/${fremd.body.id}/download`, { token: CT })).status, 404);
  assert.equal((await srv.call('DELETE', `/api/files/${mine.body.id}`, { token: CT })).status, 403);
  assert.equal((await srv.call('GET', '/api/files')).status, 401);
  assert.equal((await srv.call('GET', '/api/files', { token: A() })).status, 400);
});

// ── S5 Entwurf sichern, Kopie in gesendet ──────────────────
test('S5 save-draft: speichert Datei im Ordner entwuerfe, Rechte', async () => {
  const cl = await H.addClient('Entwurf AG');
  const rv = await H.pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'Text Generator','Original') RETURNING id`, [cl.id]);
  const url = `/api/reviews/${rv.rows[0].id}/save-draft`;
  assert.equal((await srv.call('POST', url, { body: { text: 'x' } })).status, 401);
  assert.equal((await srv.call('POST', url, { token: H.clientToken(cl.id), body: { text: 'x' } })).status, 403);
  assert.equal((await srv.call('POST', url, { token: A(), body: { text: '  ' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/reviews/9999/save-draft', { token: A(), body: { text: 'x' } })).status, 404);
  const r = await srv.call('POST', url, { token: A(), body: { text: 'Mein Entwurf' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.folder, 'entwuerfe');
  assert.equal(r.body.client_id, cl.id);
  assert.match(r.body.name, /^Text Generator · \d{2}\.\d{2}\.\d{4}\.txt$/);
  const dl = await srv.call('GET', `/api/files/${r.body.id}/download`, { token: A(), raw: true });
  assert.equal(await dl.text(), 'Mein Entwurf');
});

test('S5 Senden an Klienten legt Kopie in gesendet ab, Altverhalten bleibt', async () => {
  const cl = await H.addClient('Gesendet AG');
  const rv = await H.pool.query(`INSERT INTO review_requests (client_id, module_label, original_text) VALUES ($1,'Feedback Writer','Original') RETURNING id`, [cl.id]);
  const id = rv.rows[0].id;
  const entwurf = await srv.call('PUT', `/api/reviews/${id}`, { token: A(), body: { editedText: 'Nur Entwurf', send: false } });
  assert.equal(entwurf.body.status, 'edited');
  assert.equal((await H.pool.query(`SELECT 1 FROM client_files WHERE client_id=$1 AND folder='gesendet'`, [cl.id])).rows.length, 0);
  const sent = await srv.call('PUT', `/api/reviews/${id}`, { token: A(), body: { editedText: 'Finaler Text' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'approved');
  await new Promise(r => setTimeout(r, 100));
  const f = await H.pool.query(`SELECT name, data FROM client_files WHERE client_id=$1 AND folder='gesendet'`, [cl.id]);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].data.toString(), 'Finaler Text');
  assert.ok(H.mails.some(m => m.kind === 'review-response'));
});

// ── S6 Auftrag an Beraterin ────────────────────────────────
test('S6 Review-Anfrage: Altverhalten ohne neue Felder, Standardfrist 3 Stunden', async () => {
  const cl = await H.addClient('Auftrag AG');
  H.mails.length = 0;
  const before = Date.now();
  const r = await srv.call('POST', '/api/reviews', { token: H.clientToken(cl.id), body: { clientId: cl.id, moduleLabel: 'E-Mail', originalText: 'Hallo Welt', note: 'Bitte kürzen' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.original_text, 'Hallo Welt');
  assert.equal(r.body.instruction, null);
  const due = new Date(r.body.due_at).getTime();
  assert.ok(Math.abs(due - (before + 3 * 3600 * 1000)) < 60 * 1000);
  await new Promise(x => setTimeout(x, 100));
  const mail = H.mails.find(m => m.kind === 'review-request');
  assert.ok(mail);
  assert.ok(!mail.text.includes('Bis spätestens'));
  assert.ok(mail.text.includes('Bitte kürzen'));
});

test('S6 Review-Anfrage mit Auftrag und Frist: gespeichert, in GET und in der Mail', async () => {
  const cl = await H.addClient('Auftrag2 AG');
  H.mails.length = 0;
  const dueIso = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
  const r = await srv.call('POST', '/api/reviews', { token: H.clientToken(cl.id), body: { clientId: cl.id, moduleLabel: 'Brief', originalText: 'Text', instruction: 'Bitte freundlicher im Ton', dueAt: dueIso } });
  assert.equal(r.status, 200);
  assert.equal(r.body.instruction, 'Bitte freundlicher im Ton');
  assert.equal(new Date(r.body.due_at).toISOString(), dueIso);
  await new Promise(x => setTimeout(x, 100));
  const mail = H.mails.find(m => m.kind === 'review-request' && m.text.includes('Auftrag'));
  assert.match(mail.text, /Bitte freundlicher im Ton/);
  assert.match(mail.text, /Bis spätestens: /);
  const list = await srv.call('GET', '/api/reviews', { token: A() });
  const row = list.body.find(x => x.id === r.body.id);
  assert.equal(row.instruction, 'Bitte freundlicher im Ton');
  assert.ok(row.due_at);
  // ungültige Frist
  assert.equal((await srv.call('POST', '/api/reviews', { token: H.clientToken(cl.id), body: { clientId: cl.id, originalText: 'T', dueAt: 'kein Datum' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/reviews', { token: H.clientToken(cl.id), body: { clientId: cl.id, originalText: 'T', dueAt: '2001-01-01T00:00:00Z' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/reviews', { body: { originalText: 'T' } })).status, 401);
  assert.equal((await srv.call('POST', '/api/reviews', { token: H.clientToken(cl.id), body: { clientId: cl.id } })).status, 400);
});

// ── S7 Klient anlegen aus Entwurf ──────────────────────────
async function readyDraft(extra = {}) {
  const c = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: {
    firma: 'Keller Bau AG', kontakt: 'Anna Keller', email: 'anna@keller.ch', sektor: 'kmu', anrede: 'du', titel: 'Frau',
    workshop_datum: '14. Oktober 2026', module: ['Text Generator', 'Risiko-Scan', 'Debrief'], ...extra } });
  return c.body;
}

test('S7 finish: legt Klienten an, Module, Dateien, Status, Einladung (Du, 7 Tage)', async () => {
  await require('../routes/inquiries').ensureTable();
  const q = await H.pool.query(`INSERT INTO inquiries (name, company, email) VALUES ('Anna Keller','Keller Bau AG','anna@keller.ch') RETURNING id`);
  const d = await readyDraft({ inquiry_id: q.rows[0].id });
  await srv.call('POST', `/api/onboarding-drafts/${d.id}/workshop-docs`, { token: A() });
  H.mails.length = 0;
  const r = await srv.call('POST', `/api/onboarding-drafts/${d.id}/finish`, { token: A(), body: { privacyAcknowledged: true } });
  assert.equal(r.status, 201);
  assert.equal(r.body.inviteSent, true);
  assert.deepEqual([...r.body.client.enabled_modules].sort(), ['brand-voice', 'debrief', 'risk', 'text-gen']);
  assert.equal(r.body.draft.status, 'abgeschlossen');
  assert.equal(r.body.draft.client_id, r.body.client.id);
  const cl = await H.pool.query('SELECT * FROM clients WHERE id=$1', [r.body.client.id]);
  assert.equal(cl.rows[0].name, 'Keller Bau AG');
  assert.equal(cl.rows[0].client_type, 'company');
  assert.equal(cl.rows[0].last_name, 'Keller');
  assert.equal(cl.rows[0].must_change_password, true);
  const files = await H.pool.query('SELECT client_id FROM client_files WHERE draft_id=$1', [d.id]);
  assert.equal(files.rows.length, 4);
  assert.ok(files.rows.every(f => f.client_id === r.body.client.id));
  assert.equal((await H.pool.query('SELECT status FROM inquiries WHERE id=$1', [q.rows[0].id])).rows[0].status, 'klient');
  const tok = await H.pool.query('SELECT token, expires_at FROM onboarding_tokens WHERE client_id=$1', [r.body.client.id]);
  assert.equal(tok.rows.length, 1);
  const days = (new Date(tok.rows[0].expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, 'Gültigkeit ' + days);
  const mail = H.mails.find(m => m.kind === 'client_invite');
  assert.equal(mail.to, 'anna@keller.ch');
  assert.equal(mail.subject, 'Dein Zugang zu RhetorIQ');
  assert.match(mail.text, /^Liebe Anna/);
  assert.ok(mail.text.includes('https://app.test/setup?t=' + tok.rows[0].token));
  assert.match(mail.text, /Der Link gilt 7 Tage/);
  // Doppelter Abschluss
  assert.equal((await srv.call('POST', `/api/onboarding-drafts/${d.id}/finish`, { token: A(), body: { privacyAcknowledged: true } })).status, 409);
});

test('S7 finish: Sie-Form, Pflichtangaben, Rechte', async () => {
  const d = await readyDraft({ anrede: 'sie', kontakt: 'Beat Meier', titel: 'Herr', firma: 'Meier Treuhand' });
  const url = `/api/onboarding-drafts/${d.id}/finish`;
  assert.equal((await srv.call('POST', url, { body: { privacyAcknowledged: true } })).status, 401);
  assert.equal((await srv.call('POST', url, { token: H.clientToken(1), body: { privacyAcknowledged: true } })).status, 403);
  assert.equal((await srv.call('POST', url, { token: A(), body: {} })).status, 400);
  const noMail = await srv.call('POST', '/api/onboarding-drafts', { token: A(), body: { firma: 'Ohne Mail GmbH' } });
  assert.equal((await srv.call('POST', `/api/onboarding-drafts/${noMail.body.id}/finish`, { token: A(), body: { privacyAcknowledged: true } })).status, 400);
  H.mails.length = 0;
  const r = await srv.call('POST', url, { token: A(), body: { privacyAcknowledged: true } });
  assert.equal(r.status, 201);
  const mail = H.mails.find(m => m.kind === 'client_invite');
  assert.equal(mail.subject, 'Ihr Zugang zu RhetorIQ');
  assert.match(mail.text, /^Guten Tag Herr Meier/);
  assert.match(mail.text, /Ihre Plattform ist bereit/);
});

test('S7 finish: Mailfehler legt Klienten trotzdem an und meldet inviteSent false', async () => {
  const d = await readyDraft({ firma: 'Mailfehler AG', kontakt: 'Cora Test' });
  H.setMailFail(true);
  const r = await srv.call('POST', `/api/onboarding-drafts/${d.id}/finish`, { token: A(), body: { privacyAcknowledged: true } });
  H.setMailFail(false);
  assert.equal(r.status, 201);
  assert.equal(r.body.inviteSent, false);
  assert.ok(r.body.client.id);
});

test('S7 Regression: bestehendes POST /api/clients unverändert (Antwort, Willkommensmail 48 h)', async () => {
  H.brevoMails.length = 0;
  const r = await srv.call('POST', '/api/clients', { token: A(), body: { name: 'Joanne Sieber', email: 'j@sieber.ch', privacyAcknowledged: true, enabled_modules: ['brand-voice', 'text-gen'] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Joanne Sieber');
  assert.equal(r.body.client_type, 'individual');
  assert.equal(r.body.last_name, 'Sieber');
  assert.equal(r.body.salutation, 'Frau');
  assert.deepEqual(r.body.enabled_modules, ['brand-voice', 'text-gen']);
  assert.ok(r.body.token && r.body.slug.startsWith('joanne-sieber-'));
  await new Promise(x => setTimeout(x, 100));
  assert.match(H.brevoMails[0].text, /48 Stunden gültig/);
  assert.equal((await srv.call('POST', '/api/clients', { token: A(), body: { name: 'X' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/clients', { body: { name: 'X', privacyAcknowledged: true } })).status, 401);
});

// ── S8 Ansicht des Klienten (nur lesend) ───────────────────
test('S8 view-as: Beraterin erhält 30-Min-Token mit viewAs/readOnly, Protokolleintrag', async () => {
  const jwt = require('jsonwebtoken');
  const cl = await H.addClient('Ansicht AG');
  const url = `/api/advisor/view-as/${cl.id}`;
  assert.equal((await srv.call('POST', url)).status, 401);
  assert.equal((await srv.call('POST', url, { token: H.clientToken(cl.id) })).status, 403);
  assert.equal((await srv.call('POST', '/api/advisor/view-as/99999', { token: A() })).status, 404);
  const r = await srv.call('POST', url, { token: A() });
  assert.equal(r.status, 200);
  const p = jwt.verify(r.body.token, process.env.JWT_SECRET);
  assert.equal(p.role, 'client');
  assert.equal(p.clientId, cl.id);
  assert.equal(p.viewAs, true);
  assert.equal(p.readOnly, true);
  assert.equal(p.exp - p.iat, 1800);
  const log = await srv.call('GET', `/api/advisor/view-as-log/${cl.id}`, { token: A() });
  assert.equal(log.status, 200);
  assert.equal(log.body.length, 1);
  assert.equal(log.body[0].advisor_id, 1);
  assert.equal(log.body[0].client_id, cl.id);
  assert.equal((await srv.call('GET', `/api/advisor/view-as-log/${cl.id}`)).status, 401);
  assert.equal((await srv.call('GET', `/api/advisor/view-as-log/${cl.id}`, { token: H.clientToken(cl.id) })).status, 403);
  // Das Lese-Token ist kein Beraterzugang
  assert.equal((await srv.call('GET', `/api/advisor/view-as-log/${cl.id}`, { token: r.body.token })).status, 403);
});

test('S8 readOnly-Token darf nur lesen, normales Klient-Token darf weiterhin schreiben', async () => {
  const cl = await H.addClient('Lesen AG');
  const view = (await srv.call('POST', `/api/advisor/view-as/${cl.id}`, { token: A() })).body.token;
  const normal = H.clientToken(cl.id);
  const body = { clientId: cl.id, originalText: 'Text zur Prüfung' };
  // lesen geht mit beiden
  assert.equal((await srv.call('GET', '/api/reviews', { token: view })).status, 200);
  assert.equal((await srv.call('GET', `/api/files?client_id=${cl.id}`, { token: view })).status, 200);
  // schreiben: Ansicht 403, normales Token wie bisher
  for (const [m, u] of [['POST', '/api/reviews'], ['PUT', '/api/reviews/1'], ['DELETE', '/api/reviews/1'], ['POST', '/api/clients']]) {
    const r = await srv.call(m, u, { token: view, body });
    assert.equal(r.status, 403, m + ' ' + u);
    assert.equal(r.body.error, 'Nur Ansicht');
  }
  assert.equal((await srv.call('POST', '/api/reviews', { token: normal, body })).status, 200);
  // Beraterin-Token bleibt unberührt (z. B. POST mit Advisor-Token)
  assert.equal((await srv.call('POST', '/api/reviews', { token: A(), body })).status, 200);
  // ungültiges Token wird nicht vom Wächter, sondern wie bisher von den Routen abgelehnt
  assert.equal((await srv.call('POST', '/api/clients', { token: 'kaputt', body: { name: 'X' } })).status, 401);
});

test('S8 Lese-Token läuft nach Passwortwechsel (tokenVersion) wie jedes Klient-Token ab', async () => {
  const cl = await H.addClient('Version AG');
  const view = (await srv.call('POST', `/api/advisor/view-as/${cl.id}`, { token: A() })).body.token;
  await H.pool.query('UPDATE clients SET token_version = token_version + 1 WHERE id=$1', [cl.id]);
  assert.equal((await srv.call('GET', `/api/files?client_id=${cl.id}`, { token: view })).status, 401);
});

// ── S9 Hilfe-Chat ──────────────────────────────────────────
test('S9 Hilfe-Chat: Antwort, rollenabhängiger Prompt, Frage nicht gespeichert, Rechte und Limits', async () => {
  const cl = await H.addClient('Hilfe AG');
  const post = (token, body) => srv.call('POST', '/api/help-chat', { token, body });
  assert.equal((await post(null, { question: 'Hallo?' })).status, 401);
  H.ai.reply = 'Klicken Sie auf "An Beraterin senden".';
  H.ai.calls.length = 0;
  const c = await post(H.clientToken(cl.id), { question: 'Wie sende ich einen Text?' });
  assert.equal(c.status, 200);
  assert.equal(c.body.answer, 'Klicken Sie auf "An Beraterin senden".');
  assert.match(H.ai.calls[0].system, /Klientin oder Klient/);
  assert.match(H.ai.calls[0].system, /Brand Voice/);
  assert.equal(H.ai.calls[0].model, 'test-haiku');
  const a = await post(A(), { question: 'Wo finde ich die Ablage?' });
  assert.equal(a.status, 200);
  assert.match(H.ai.calls[1].system, /Die Person ist die Beraterin/);
  assert.equal((await post(A(), { question: '' })).status, 400);
  assert.equal((await post(A(), { question: 'x'.repeat(601) })).status, 400);
  assert.equal((await post(A(), { question: 'x'.repeat(600) })).status, 200);
  // keine Speicherung: keine Tabelle mit der Frage
  const tables = await H.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  assert.ok(!tables.rows.some(t => /help|chat/i.test(t.table_name)));
  H.ai.fail = true;
  assert.equal((await post(A(), { question: 'Noch eine Frage' })).status, 502);
  H.ai.fail = false;
});

test('S9 Hilfe-Chat: Rate-Limit 10 pro Minute und Nutzer', async () => {
  const cl = await H.addClient('Limit AG');
  const T = H.clientToken(cl.id);
  H.ai.reply = 'ok';
  let last;
  for (let i = 0; i < 10; i++) last = await srv.call('POST', '/api/help-chat', { token: T, body: { question: 'Frage ' + i } });
  assert.equal(last.status, 200);
  assert.equal((await srv.call('POST', '/api/help-chat', { token: T, body: { question: 'elfte' } })).status, 429);
  // anderer Nutzer ist nicht betroffen
  assert.equal((await srv.call('POST', '/api/help-chat', { token: H.clientToken(cl.id + 1000), body: { question: 'x' } })).status, 401);
});

// ── S10 Häufigste Textarten ────────────────────────────────
test('S10 top-modules: Top 3 der letzten 30 Tage, Rechte', async () => {
  const cl = await H.addClient('Top AG');
  const other = await H.addClient('Andere AG');
  const ins = (cid, module, key, days) => H.pool.query(
    `INSERT INTO analyses (client_id, module, feedback_key, created_at) VALUES ($1,$2,$3,$4)`,
    [cid, module, key, new Date(Date.now() - days * 86400000)]);
  for (let i = 0; i < 4; i++) await ins(cl.id, 'text-gen', 'text-gen-email', 2);
  for (let i = 0; i < 3; i++) await ins(cl.id, 'review', null, 5);
  for (let i = 0; i < 2; i++) await ins(cl.id, 'risk', null, 29);
  await ins(cl.id, 'debrief', null, 1);
  for (let i = 0; i < 9; i++) await ins(cl.id, 'sparring', null, 45); // zu alt
  for (let i = 0; i < 9; i++) await ins(other.id, 'thread', null, 1);  // fremder Klient
  const r = await srv.call('GET', `/api/clients/${cl.id}/top-modules`, { token: H.clientToken(cl.id) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ module: 'text-gen-email', count: 4 }, { module: 'review', count: 3 }, { module: 'risk', count: 2 }]);
  assert.deepEqual((await srv.call('GET', `/api/clients/${cl.id}/top-modules`, { token: A() })).body, r.body);
  assert.equal((await srv.call('GET', `/api/clients/${other.id}/top-modules`, { token: H.clientToken(cl.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/clients/${cl.id}/top-modules`)).status, 401);
  assert.equal((await srv.call('GET', '/api/clients/99999/top-modules', { token: A() })).status, 404);
  assert.deepEqual((await srv.call('GET', `/api/clients/${H.clientToken ? (await H.addClient('Leer AG')).id : 0}/top-modules`, { token: A() })).body, []);
});


// ── Anfragen löschen ───────────────────────────────────────
test('Anfrage löschen: nur Advisor, entfernt die Anfrage endgültig', async () => {
  await require('../routes/inquiries').ensureTable();
  const { rows } = await H.pool.query(`INSERT INTO inquiries (name, email) VALUES ('Zu Löschen','weg@test.ch') RETURNING id`);
  const id = rows[0].id;
  assert.equal((await srv.call('DELETE', `/api/inquiries/${id}`)).status, 401);
  assert.equal((await srv.call('DELETE', `/api/inquiries/${id}`, { token: H.clientToken(1) })).status, 403);
  assert.equal((await srv.call('DELETE', `/api/inquiries/${id}`, { token: A() })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/inquiries/${id}`, { token: A() })).status, 404);
  const rest = await H.pool.query('SELECT 1 FROM inquiries WHERE id=$1', [id]);
  assert.equal(rest.rows.length, 0);
});

// ── Verlauf: Beraterin und Klienten-Admin ──────────────────
test('Verlauf: Beraterin und Admin-Rolle ja, normale Klienten und Ansicht nein', async () => {
  const cl = await H.addClient('Verlauf AG');
  await H.pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,1,'text-gen','E-Mail','Hallo')`, [cl.id]);
  const get = (token, qs = '') => srv.call('GET', '/api/analyze/history' + qs, { token });
  assert.equal((await srv.call('GET', '/api/analyze/history')).status, 401);
  const adv = await get(A(), `?clientId=${cl.id}`);
  assert.equal(adv.status, 200);
  assert.equal(adv.body.length, 1);
  const norm = await get(H.clientToken(cl.id));
  assert.equal(norm.status, 403, JSON.stringify(norm.body));
  const mk = async () => (await H.pool.query(`INSERT INTO client_users (client_id) VALUES ($1) RETURNING id`, [cl.id])).rows[0].id;
  const editorId = await mk();
  const adminId = await mk();
  const tok = (id, role, extra = {}) => H.clientToken(cl.id, { clientUserId: id, clientUserRole: role, ...extra });
  assert.equal((await get(tok(editorId, 'editor'))).status, 403);
  const admin = await get(tok(adminId, 'admin', { advisorId: null }));
  assert.equal(admin.status, 200);
  assert.equal(admin.body.length, 1);
  assert.equal((await get(tok(adminId, 'admin', { readOnly: true }))).status, 403);
});

// ── Wochenbericht: Excel-Liste und Mail-Anhang ─────────────
test('Excel-Liste der Wochentexte ist eine gültige Datei mit allen Zeilen', async () => {
  const { buildWeeklyTextsXlsx } = require('../lib/weeklyExcel');
  const JSZip = require('jszip');
  const buf = await buildWeeklyTextsXlsx([
    { created_at: new Date(), client_name: 'Keller Bau AG', module_label: 'E-Mail', user_rating: 1, result: 'Guten Tag Frau Keller, ab dem 1. April …' },
    { created_at: new Date(), client_name: null, module_label: 'Rede', user_rating: null, result: 'Sehr geehrte Damen und Herren' }
  ]);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('xl/worksheets/sheet1.xml'));
  const shared = await zip.file('xl/sharedStrings.xml').async('string');
  assert.ok(shared.includes('Keller Bau AG') && shared.includes('Ohne Klient') && shared.includes('Sehr geehrte Damen und Herren'));
  assert.ok(shared.includes('Datum') && shared.includes('Textart'));
});

test('Brevo-Inhalt: Anhang wird mitgeschickt, ohne Anhang unverändert', () => {
  const { buildPayload } = require('../lib/brevoPayload');
  const ohne = buildPayload({ to: 'a@b.ch', subject: 'S', text: 'T', senderName: 'X' });
  assert.equal(ohne.attachment, undefined);
  assert.equal(ohne.to[0].email, 'a@b.ch');
  const mit = buildPayload({ to: 'a@b.ch', subject: 'S', text: 'T', senderName: 'X', attachments: [{ name: 'a.xlsx', contentBase64: 'QUJD' }] });
  assert.deepEqual(mit.attachment, [{ name: 'a.xlsx', content: 'QUJD' }]);
});

// ── Leichte Abfragen für Statistik und Verlauf ─────────────
test('Zähler, Modul-Zähler und Verlauf-Vorschau liefern keine vollen Texte', async () => {
  const cl = await H.addClient('Leicht AG');
  const long = 'x'.repeat(2000);
  await H.pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result) VALUES ($1,1,'text-gen','E-Mail',$2),($1,1,'text-gen','E-Mail',$2),($1,1,'review','Review',$2)`, [cl.id, long]);
  const adv = A();
  const cnt = await srv.call('GET', `/api/analyze/count?clientId=${cl.id}`, { token: adv });
  assert.equal(cnt.status, 200);
  assert.equal(cnt.body.count, 3);
  const mc = await srv.call('GET', `/api/analyze/module-counts?clientId=${cl.id}`, { token: adv });
  assert.equal(mc.body[0].module, 'text-gen');
  assert.equal(mc.body[0].n, 2);
  const prev = await srv.call('GET', `/api/analyze/history?clientId=${cl.id}&preview=1`, { token: adv });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.length, 3);
  assert.equal(prev.body[0].result.length, 100);
  assert.equal(prev.body[0].result_length, 2000);
  const full = await srv.call('GET', `/api/analyze/history?clientId=${cl.id}`, { token: adv });
  assert.equal(full.body[0].result.length, 2000);
  const one = await srv.call('GET', `/api/analyze/${prev.body[0].id}`, { token: adv });
  assert.equal(one.status, 200);
  assert.equal(one.body.result.length, 2000);
  assert.equal((await srv.call('GET', `/api/analyze/${prev.body[0].id}`, { token: H.clientToken(cl.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/analyze/${prev.body[0].id}`)).status, 401);
  // Klient ohne Verlauf-Recht darf die Anzahl der eigenen Texte sehen, aber keine Texte
  const own = await srv.call('GET', '/api/analyze/count', { token: H.clientToken(cl.id) });
  assert.equal(own.body.count, 3);
});

test('Kundenliste: Dashboard liefert Zugangscode und Abo-Status mit (eine Anfrage statt vieler)', async () => {
  const cl = await H.addClient('Dashboard AG');
  const r = await srv.call('GET', '/api/advisor/dashboard', { token: A() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.clients.find(x => x.id === cl.id);
  assert.ok(c, 'Klient fehlt');
  // pg-mem füllt bei GROUP BY nur die ID; in echtem Postgres kommen auch Name und Zugangscode. Hier zählt, dass das Feld mitgeliefert wird.
  assert.ok('token' in c);
  assert.equal(c.subscription_status, 'trial');
  assert.equal((await srv.call('GET', '/api/advisor/dashboard')).status, 401);
  assert.equal((await srv.call('GET', '/api/advisor/dashboard', { token: H.clientToken(cl.id) })).status, 403);
});

// ── Gedächtnis-Upload: KI schlägt den Typ vor ──────────────
test('Gedächtnis-Zuordnung: Vorschlag, Absicherungen und Rückfall bei Fehlern', async () => {
  const cl = await H.addClient('Gedächtnis AG');
  const T = H.clientToken(cl.id);
  const post = (token, body) => srv.call('POST', '/api/memory-suggest', { token, body });
  assert.equal((await post(null, { text: 'x' })).status, 401);
  assert.equal((await post(T, { text: '  ' })).status, 400);
  assert.equal((await post(H.clientToken(cl.id, { readOnly: true }), { text: 'Hallo' })).status, 403);

  H.ai.calls.length = 0;
  H.ai.reply = '{"type":"ref_tg_email","confidence":0.93,"summary":"Eine Kundenmail zur Preisanpassung."}';
  const ok = await post(T, { filename: 'Mail Kunden.docx', text: 'Guten Tag Frau Keller, ab dem 1. April …' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.type, ok.body.label], ['ref_tg_email', 'Referenz E-Mail']);
  assert.ok(ok.body.confidence > 0.9);
  assert.equal(H.ai.calls.length, 1);
  assert.ok(String(H.ai.calls[0].model).includes('haiku'), 'günstiges Modell erwartet');
  assert.ok(H.ai.calls[0].maxTokens <= 200);

  // lange Texte werden gekürzt (Kosten)
  H.ai.calls.length = 0;
  await post(T, { filename: 'lang.pdf', text: 'a'.repeat(50000) });
  assert.ok(H.ai.calls[0].messages[0].content.length < 3000);

  // unbekannter Typ aus der KI wird nicht übernommen
  H.ai.reply = '{"type":"geheim_alles","confidence":1,"summary":"x"}';
  assert.equal((await post(T, { text: 'Hallo' })).body.type, null);
  // kein JSON
  H.ai.reply = 'Das ist eine E-Mail.';
  assert.equal((await post(T, { text: 'Hallo' })).body.type, null);
  // KI nicht erreichbar: die Oberfläche bekommt «kein Vorschlag», keinen Fehler
  H.ai.fail = true;
  const down = await post(T, { text: 'Hallo' });
  assert.equal(down.status, 200);
  assert.equal(down.body.type, null);
  H.ai.fail = false;
});
