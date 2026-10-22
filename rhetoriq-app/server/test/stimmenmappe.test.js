// Brand-Voice-Handbuch und Handbuch: Erzeugung, Zugriff nur für die Beraterin, Inhalt. Keine KI.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const { pool } = require('../db');

let srv, a, b;
async function wordText(buf) {
  const z = await JSZip.loadAsync(buf);
  const xml = await z.file('word/document.xml').async('string');
  return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}
async function fetchBuf(url, token) {
  const r = await srv.call('GET', url, { token, raw: true });
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
}

test.before(async () => {
  await H.setupBase();
  await pool.query(`CREATE TABLE company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE people (id SERIAL PRIMARY KEY, client_id INTEGER, name TEXT, role TEXT, department TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE people_profiles (id SERIAL PRIMARY KEY, person_id INTEGER, profile_type TEXT, content TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE client_module_prompts (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT, instructions TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ, satz_meta JSONB)`);
  a = await H.addClient('Alpha AG');
  b = await H.addClient('Beta AG');
  await pool.query(`UPDATE clients SET industry='Maschinenbau', contact='Frau Keller' WHERE id=$1`, [a.id]);
  const bv = '# Brand Voice\nTon: klar, warm, direkt\nWir duzen unsere Kundschaft.\n\n## Do\n- Kurze Sätze\n- Konkrete Beispiele\n\n## Don\'t\n- Fachjargon\n- Ausrufezeichen';
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice',$2),($1,'ref_tg_email','Beispielmail Alpha'),($1,'key_facts','Gegründet 1998')`, [a.id, bv]);
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice','GEHEIM BETA')`, [b.id]);
  const pe = (await pool.query(`INSERT INTO people (client_id, name, role) VALUES ($1,'Hans Muster','Geschäftsleiter') RETURNING id`, [a.id])).rows[0].id;
  await pool.query(`INSERT INTO people_profiles (person_id, profile_type, content) VALUES ($1,'voice_dna','spricht in kurzen Sätzen')`, [pe]);
  await pool.query(`INSERT INTO client_module_prompts (client_id, module_key, instructions) VALUES ($1,'text-gen-email','Immer mit Vornamen anreden')`, [a.id]);
  await pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary, updated_at) VALUES ($1,'text-gen-email','TON','Weniger Floskeln am Anfang. Keine Ausrufezeichen.', NOW())`, [a.id]);
  const longText = 'Guten Tag Frau Keller. Wir liefern die Maschine am Dienstag. Bitte bestätigen Sie den Termin bis Freitag. Danke für Ihr Vertrauen in unsere Arbeit.';
  await pool.query(`INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status) VALUES ($1,'E-Mail','x',$2,'approved'),($1,'LinkedIn','y',$2,'approved'),($1,'Offen','z',$2,'pending')`, [a.id, longText]);
  srv = await H.startApp([['/api/stimmenmappe', require('../routes/stimmenmappe')]]);
});
test.after(async () => { await srv.close(); });

test('Brand-Voice-Handbuch: alle Abschnitte mit Inhalt des Klienten', async () => {
  const r = await fetchBuf(`/api/stimmenmappe/${a.id}.docx`, H.advisorToken());
  assert.equal(r.status, 200);
  assert.match(r.type, /wordprocessingml/);
  const t = await wordText(r.buf);
  for (const s of ['Brand-Voice-Handbuch', 'Alpha AG', 'Maschinenbau', 'Frau Keller', 'Brand Voice vollständig', 'klar, warm, direkt',
    'Die zehn Regeln', 'Referenztexte', 'Beispielmail Alpha', 'Gegründet 1998', 'Hans Muster', 'spricht in kurzen Sätzen',
    'Immer mit Vornamen anreden', 'Weniger Floskeln am Anfang', 'Mustertexte', 'Guten Tag Frau Keller', 'Stimmprofil mit Zielwerten']) {
    assert.ok(t.includes(s), 'fehlt: ' + s);
  }
  assert.ok(!t.includes('GEHEIM BETA'), 'keine Daten anderer Klienten');
  assert.equal((t.match(/Muster \d:/g) || []).length, 2, 'nur gesendete Freigaben als Muster');
  assert.ok(!/[–—]/.test(t), 'keine Gedankenstriche');
});

test('Zehn Regeln: gelernte Sätze zuerst, dann Do und Don\'t, dann Grundregeln', () => {
  const sm = require('../lib/stimmenmappe');
  return sm.collect(a.id).then(d => {
    const rules = sm.tenRules(d);
    assert.equal(rules.length, 10);
    assert.equal(rules[0].from, 'gelernte Vorliebe');
    assert.ok(rules.some(r => r.text === 'Kurze Sätze'));
    assert.ok(rules.some(r => r.text === 'Vermeiden: Fachjargon'));
  });
});

test('Handbuch: Satzbau mit Zahlen, Anrede, Prüfliste', async () => {
  const r = await fetchBuf(`/api/stimmenmappe/${a.id}/handbuch.docx`, H.advisorToken());
  assert.equal(r.status, 200);
  const t = await wordText(r.buf);
  assert.ok(t.includes('Kurzanleitung'));
  assert.ok(t.includes('klar, warm, direkt'));
  assert.ok(t.includes('Du-Form'));
  assert.match(t, /Durchschnittlich \d+(\.\d)? Wörter pro Satz/);
  assert.ok(t.includes('Prüfliste vor dem Senden'));
  assert.ok(t.includes('Fachjargon'));
});

test('Prüfpaket: Brand Voice, Fassungen mit Hinweis und Befunde', async () => {
  const { pool } = require('../db');
  await require('../lib/schemaRedesign').ensureSchema();
  const ein = { briefing: 'Mail zur Preisänderung' };
  await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result, feedback_key, ueberarbeitung, ueberarbeitung_hinweis, created_at)
    VALUES ($1,$2,'text-gen','Textgenerator',$3,$4,'text-gen-email',false,NULL,NOW() - INTERVAL '2 hours')`, [a.id, 1, JSON.stringify(ein), 'Das ist keine Mahnung. Das ist ein Hinweis \u2013 bitte lesen.']);
  await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result, feedback_key, ueberarbeitung, ueberarbeitung_hinweis, created_at)
    VALUES ($1,$2,'text-gen','Textgenerator',$3,$4,'text-gen-email',true,'Kürzer und freundlicher',NOW() - INTERVAL '1 hour')`, [a.id, 1, JSON.stringify(ein), 'Bitte beachten Sie den Hinweis zur Preisänderung.']);
  const r = await fetchBuf(`/api/stimmenmappe/${a.id}/pruefpaket.docx`, H.advisorToken());
  assert.equal(r.status, 200);
  const t = await wordText(r.buf);
  assert.ok(t.includes('Prüfpaket'));
  assert.ok(t.includes('Erstfassung') && t.includes('Überarbeitung 1'));
  assert.ok(t.includes('Hinweis für die Überarbeitung: Kürzer und freundlicher'));
  assert.ok(t.includes('Gedankenstrich'));
  assert.equal((await fetchBuf(`/api/stimmenmappe/${a.id}/pruefpaket.docx`, H.clientToken(a.id))).status, 403);
});

test('ZIP über alle Klienten der Beraterin', async () => {
  const r = await fetchBuf('/api/stimmenmappe/alle.zip', H.advisorToken());
  assert.equal(r.status, 200);
  const z = await JSZip.loadAsync(r.buf);
  const names = Object.keys(z.files).filter(n => n.endsWith('.docx'));
  assert.equal(names.length, 4);
  assert.ok(names.some(n => n.includes('Brand-Voice-Handbuch_Alpha_AG')));
  assert.ok(names.some(n => n.includes('Kurzanleitung_Beta_AG')));
});

test('Zugriff nur für die Beraterin', async () => {
  assert.equal((await fetchBuf(`/api/stimmenmappe/${a.id}.docx`)).status, 401);
  assert.equal((await fetchBuf(`/api/stimmenmappe/${a.id}.docx`, H.clientToken(a.id))).status, 403);
  assert.equal((await fetchBuf(`/api/stimmenmappe/${a.id}/handbuch.docx`, H.clientToken(a.id))).status, 403);
  assert.equal((await fetchBuf('/api/stimmenmappe/alle.zip', H.clientToken(a.id))).status, 403);
  assert.equal((await fetchBuf('/api/stimmenmappe/alle.zip')).status, 401);
});

test('Monatserinnerung: Mail ohne Anhang an Lorena', async () => {
  H.mails.length = 0;
  await require('../jobs/stimmenmappe-erinnerung').runErinnerung();
  assert.equal(H.mails.length, 1);
  assert.equal(H.mails[0].attachments, undefined);
  assert.match(H.mails[0].subject, /Monatsexport der Brand-Voice-Handbücher/);
  assert.ok(!/[–—]/.test(H.mails[0].text));
});

test('Prüfpaket wählt Aufträge aus verschiedenen Textarten vor weiteren der gleichen Art', () => {
  const { auswahl } = require('../lib/pruefpaket');
  const mk = (id, mod, key, min, ein) => ({ id, module: mod, feedback_key: key, input_data: { briefing: ein }, created_at: new Date(Date.now() - min * 60000).toISOString(), result: 'x' });
  const an = [
    mk(1, 'text-gen', 'text-gen-email', 1, 'a'), mk(2, 'text-gen', 'text-gen-email', 2, 'b'), mk(3, 'text-gen', 'text-gen-email', 3, 'c'),
    mk(4, 'text-gen', 'text-gen-linkedin', 50, 'd'), mk(5, 'brand-voice', 'brand-voice', 60, 'e'), mk(6, 'text-gen', 'text-gen-speech', 70, 'f')
  ];
  const ids = auswahl(an, 4).map(l => l[l.length - 1].id);
  assert.deepEqual(ids.sort(), [1, 4, 5, 6]);
});
