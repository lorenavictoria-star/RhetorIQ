// Test «Wie klingt Ihre Firma?», zweite Ausbaustufe: Kennzahlen, Zitatprüfung, Fallback, Auswahl, Statuswechsel, PDF und Versand (pg-mem, Attrappen).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const A = require('../lib/schnelltestAnalyse');
const { erzeugePdf } = require('../lib/schnelltestPdf');

const ZEILEN = [
  'Wir sind ein führender Anbieter ganzheitlicher Lösungen im Sinne nachhaltiger Wertschöpfung für unsere Kundschaft und begleiten Unternehmen mit höchster Qualität bei der Durchführung der Umsetzung ihrer Vorhaben, weil wir davon überzeugt sind, dass nur eine ganzheitliche Betrachtung zum Erfolg führt.',
  'Unser kompetenter Partner steht Ihnen bei der Bereitstellung massgeschneiderter Lösungen zur Seite.',
  'Wir bieten Beratung, Schulung und Begleitung. Wir arbeiten mit Leidenschaft für Ihren Erfolg.',
  'Unsere Dienstleistungen werden von erfahrenen Fachleuten erbracht und regelmässig überprüft worden.',
  'Wir verstehen uns als Partner auf Augenhöhe und setzen auf Qualität, Zuverlässigkeit und Menschlichkeit in der Zusammenarbeit.',
  'Die Verwaltung der Unterlagen wird durch unser Team übernommen, die Genauigkeit der Abläufe wird laufend verbessert.',
  'Wir freuen uns, wenn Sie uns kontaktieren, und zeigen Ihnen gern, wie wir Ihnen helfen.',
  'Unsere Kundschaft schätzt unsere Erfahrung, unsere Nähe und unsere Verlässlichkeit.',
  'Wir sind für Sie da. Wir hören zu. Wir handeln.',
  'Mit unserer Erfahrung begleiten wir Sie Schritt für Schritt durch alle Phasen Ihres Vorhabens und achten dabei auf Ihre Ziele.',
  'Wir setzen auf Transparenz in der Kommunikation.',
  'Zuverlässigkeit ist für uns die Grundlage jeder Zusammenarbeit mit Ihnen.'
];
const TEXT = ZEILEN.join('\n');
const html = (zeilen, extra = '') => '<html><head><title>Muster AG</title></head><body><nav><a href="/x">Menü</a> Home Kontakt</nav>' + zeilen.map(z => `<p>${z}</p>`).join('') + extra + '<footer>Impressum Datenschutz</footer></body></html>';

test('Kennzahlen: Satzlänge, lange Sätze, Wir und Sie, Floskeln, Nominalstil, Passiv', () => {
  const k = A.berechneKennzahlen(TEXT);
  assert.ok(k.woerter > 150);
  assert.ok(k.saetze >= 12 && k.woerterProSatz > 5 && k.woerterProSatz < 30);
  assert.equal(k.langeSaetze, 1, 'nur der erste Satz hat mehr als 25 Wörter');
  assert.equal(k.anteilLangeSaetze, Math.round(100 / k.saetze));
  assert.ok(k.floskeln.treffer >= 6, 'ganzheitlich, höchste Qualität, kompetenter Partner, massgeschneidert, Augenhöhe, Leidenschaft');
  assert.ok(k.floskeln.liste.some(x => x.floskel === 'ganzheitlich' && x.anzahl === 2));
  assert.ok(k.nominalstil.anteil > 2 && k.nominalstil.naeherung === true);
  assert.ok(k.passiv.saetze >= 2 && k.passiv.naeherung === true);
  assert.ok(k.wir > k.sie && k.sie >= 0 && k.wir != null);
});

test('Kennzahlen: bei zu wenig Text keine unsicheren Zahlen', () => {
  const k = A.berechneKennzahlen('Wir sind ein Team. Wir helfen Ihnen gern.');
  assert.equal(k.woerterProSatz, null);
  assert.equal(k.anteilLangeSaetze, null);
  assert.equal(k.passiv, null);
  assert.equal(k.nominalstil, null);
  assert.equal(k.wir, null);
});

test('Kennzahlen: Abkürzungen und Zahlen trennen keine Sätze, Menüzeilen zählen nicht', () => {
  const s = A.saetze('Wir haben z. B. 3.5 Prozent mehr Kundschaft gewonnen.\nHome Über uns Kontakt\nDas ist ein ganz normaler Satz.');
  assert.equal(s.length, 2);
});

test('Floskelliste hat mindestens 40 Einträge', () => { assert.ok(A.FLOSKELN.length >= 40); });

test('Zitatprüfung: nur exakte Teilstrings, Leerzeichen normalisiert', () => {
  const idx = A.textIndex('Wir bieten   Beratung,\nSchulung und «Begleitung» für alle.');
  assert.equal(A.findeZitat(idx, 'Wir bieten Beratung, Schulung und "Begleitung" für alle'), 'Wir bieten Beratung, Schulung und «Begleitung» für alle');
  assert.equal(A.findeZitat(idx, 'Wir bieten Beratung und Schulung für alle'), null);
  assert.equal(A.findeZitat(idx, 'zu kurz'), null);
});

test('pruefeKandidaten verwirft erfundene Zitate, fehlendes nachher und identisches vorher und nachher', () => {
  const beleg = 'Unser kompetenter Partner steht Ihnen bei der Bereitstellung massgeschneiderter Lösungen zur Seite.';
  const gut = { id: 'k1', kategorie: 'Floskeln', titel: 'T', beobachtung: 'B', beleg, warum: 'W', aha: 'A', vorher: beleg, nachher: 'Wir bereiten Lösungen für Sie vor.', wirkung: 'X' };
  const roh = [
    gut,
    { ...gut, id: 'k2', beleg: 'Dieser Satz steht gar nicht im gelesenen Text der Seite.', vorher: 'Dieser Satz steht gar nicht im gelesenen Text der Seite.' },
    { ...gut, id: 'k3', beleg: ZEILEN[7], vorher: ZEILEN[7], nachher: '' },
    { ...gut, id: 'k4', beleg: ZEILEN[9], vorher: ZEILEN[9], nachher: ZEILEN[9] },
    { ...gut, id: 'k5', beleg: ZEILEN[4], vorher: ZEILEN[4], aha: '' },
    { ...gut, id: 'k6', beleg: ZEILEN[10], vorher: ZEILEN[10], nachher: 'Transparenz zeigt sich in jedem Gespräch.', warum: 'Nicht Nähe, sondern Distanz entsteht.' }
  ];
  const r = A.pruefeKandidaten(roh, TEXT);
  assert.deepEqual(r.ok.map(c => c.id), ['k1', 'k6']);
  assert.equal(r.verworfen.length, 4);
  assert.equal(r.ok[0].vorher, r.ok[0].beleg);
  assert.equal(r.ok[0].automatisch, false);
  assert.equal(r.ok[1].stilwarnung, true, 'Gegenüberstellung wird markiert');
});

test('bereinige entfernt Gedankenstriche und ß', () => {
  assert.equal(A.bereinige('Das ist gut – und klar. Die Straße'), 'Das ist gut, und klar. Die Strasse');
});

test('Fallback ergänzt deterministische, als automatisch markierte Auffälligkeiten mit Zitat aus dem Text', () => {
  const k = A.berechneKennzahlen(TEXT);
  const fb = A.fallbackKandidaten(TEXT, k, { vorhanden: [] });
  assert.ok(fb.length >= 2);
  const idx = A.textIndex(TEXT);
  for (const c of fb) {
    assert.equal(c.automatisch, true);
    assert.ok(A.findeZitat(idx, c.beleg), 'Zitat im Text: ' + c.beleg);
    assert.notEqual(c.nachher, c.vorher);
    assert.ok(A.KATEGORIEN.includes(c.kategorie));
    assert.ok(!/[–—]/.test(JSON.stringify(c)), 'kein Gedankenstrich');
  }
  assert.equal(new Set(fb.map(c => c.kategorie)).size, fb.length, 'keine doppelte Kategorie');
});

test('findeLinks wählt Angebot und Über uns auf derselben Domain, sonst nichts', () => {
  const h = '<a href="/leistungen">Leistungen</a><a href="/ueber-uns">Über uns</a><a href="/team">Team</a><a href="https://fremd.ch/about">About</a><a href="/datei.pdf">Angebot</a><a href="/kontakt">Kontakt</a>';
  assert.deepEqual(A.findeLinks(h, 'https://muster.ch/', 2), ['https://muster.ch/leistungen', 'https://muster.ch/ueber-uns']);
});

test('ladeSeiten liest Startseite plus zwei interne Seiten und begrenzt den Text', async () => {
  const seiten = {
    'https://muster.ch/': { url: 'https://muster.ch/', html: html(ZEILEN.slice(0, 4), '<a href="/angebot">Angebot</a><a href="/about">About</a><a href="/team">Team</a>') },
    'https://muster.ch/angebot': { url: 'https://muster.ch/angebot', html: html(ZEILEN.slice(4, 8)) },
    'https://muster.ch/about': { url: 'https://muster.ch/about', html: html(ZEILEN.slice(8)) }
  };
  const aufgerufen = [];
  const fetchHtml = async (u) => { aufgerufen.push(u); if (!seiten[u]) throw new Error('weg'); return seiten[u]; };
  const r = await A.ladeSeiten('https://muster.ch/', fetchHtml);
  assert.equal(r.mehrseiten, 3);
  assert.ok(!aufgerufen.includes('https://muster.ch/team'), 'höchstens drei Seiten');
  assert.ok(r.text.includes('Beratung, Schulung und Begleitung'));
  assert.ok(!r.text.includes('Impressum Datenschutz') && !r.text.includes('Menü'));
  assert.ok(r.text.length <= A.GESAMT_ZEICHEN);
});

test('ladeSeiten: ein Fehler auf einer Folgeseite lässt die Startseite stehen, Zeitbudget wird eingehalten', async () => {
  const fetchHtml = async (u) => { if (/angebot/.test(u)) throw new Error('kaputt'); return { url: u, html: html(ZEILEN, '<a href="/angebot">Angebot</a>') }; };
  const r = await A.ladeSeiten('https://muster.ch/', fetchHtml);
  assert.equal(r.mehrseiten, 1);
  const langsam = () => new Promise(() => {});
  const t0 = Date.now();
  const r2 = await A.ladeSeiten('https://muster.ch/', langsam, { zeitMs: 300 });
  assert.equal(r2.mehrseiten, 0);
  assert.ok(Date.now() - t0 < 2000);
});

test('analysiere: KI-Fehler ergibt Fallback, KI-Antwort wird geprüft, Prompt bekommt Kennzahlen', async () => {
  const deps = (generate) => ({ generateText: generate, resolveModelId: (p) => 'test-' + p, extractJson: require('../lib/websiteScan').extractJson, fetchHtml: async () => { throw new Error('nicht nötig'); } });
  const startSeite = { url: 'https://muster.ch/', html: html(ZEILEN) };
  const kaputt = await A.analysiere({ url: 'https://muster.ch/', host: 'muster.ch', startSeite, deps: deps(async () => { throw new Error('KI kaputt'); }) });
  assert.ok(kaputt.kiFehler);
  assert.ok(kaputt.kandidaten.length >= 2 && kaputt.kandidaten.every(c => c.automatisch));
  assert.ok(kaputt.gesamteindruck.includes('muster.ch'));
  let gesehen;
  const beleg = ZEILEN[1];
  const antwort = JSON.stringify({ gesamteindruck: 'Klar – aber austauschbar.', staerken: [{ titel: 'Klar', text: 'Kurze Sätze am Ende.', beleg: ZEILEN[11] }, { titel: 'Erfunden', text: 'x', beleg: 'Das steht nirgends auf dieser Seite.' }],
    kandidaten: Array.from({ length: 6 }, (_, i) => ({ id: 'k' + (i + 1), kategorie: 'Floskeln', titel: 'Titel ' + i, beobachtung: 'Beob', beleg: ZEILEN[i + 1].slice(0, 90), warum: 'Weil', aha: 'Aha', vorher: '', nachher: 'Neu ' + i + ' formuliert', wirkung: 'Wirkung' })).concat([{ id: 'k7', kategorie: 'Ton', titel: 'x', beobachtung: 'b', beleg: 'Erfundenes Zitat, das niemand geschrieben hat.', warum: 'w', aha: 'a', nachher: 'n n n n n n n', wirkung: 'w' }]) });
  const ok = await A.analysiere({ url: 'https://muster.ch/', host: 'muster.ch', startSeite, deps: deps(async (o) => { gesehen = o; return { text: antwort }; }) });
  assert.equal(ok.kandidaten.length, 6, 'sechs geprüfte, das erfundene Zitat fällt weg, kein Fallback nötig');
  assert.ok(ok.kandidaten.every(c => !c.automatisch));
  assert.equal(ok.staerken.filter(s => !s.automatisch).length, 1);
  assert.equal(ok.gesamteindruck, 'Klar, aber austauschbar.');
  assert.equal(gesehen.meter.module, 'schnelltest_tief');
  assert.equal(gesehen.model, 'test-sonnet');
  assert.match(gesehen.messages[0].content, /<kennzahlen>[\s\S]*woerterProSatz/);
  void beleg;
});

test('Prompt-Regeln enthalten die geforderten Leitplanken', () => {
  for (const w of ['wörtlich', 'Erfinde nichts', 'widersprechen', 'Umsatz', 'Nominalstil', 'Passiv', 'Satzklammer', 'Glaubwürdigkeit', 'Keine Gedankenstriche', 'Schweizer Rechtschreibung']) assert.ok(A.SYSTEM_TIEF.includes(w), w);
});

const seitenZahl = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;
const KAND = (i) => ({ id: 'k' + i, kategorie: 'Satzbau', titel: 'Der Auftakt dauert ' + i, beobachtung: 'Beobachtung. '.repeat(10), beleg: ZEILEN[0], warum: 'Weil Sätze mit Satzklammer das Arbeitsgedächtnis fordern. '.repeat(8), aha: 'Lange Sätze wirken gründlich und kosten Kraft.', vorher: ZEILEN[0], nachher: 'Wir begleiten Unternehmen. ' .repeat(8), wirkung: 'Der Text liest sich in einem Zug. '.repeat(4), automatisch: false });

test('PDF hat drei A4-Seiten, auch bei langen Texten, und enthält die Fussnote', async () => {
  const k = A.berechneKennzahlen(TEXT);
  const pdf = await erzeugePdf({ host: 'muster.ch', url: 'https://muster.ch', firma: 'Muster AG', datum: new Date(), gesamteindruck: 'Eindruck. '.repeat(30), kennzahlen: k, mehrseiten: 3, staerken: [{ titel: 'A', text: 'B', beleg: null }, { titel: 'C', text: 'D', beleg: ZEILEN[11] }], kandidaten: [KAND(1), KAND(2), KAND(3)], notiz: 'Meine Einschätzung. '.repeat(40) });
  const buf = pdf.buf;
  assert.equal(pdf.seiten, 3);
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
  assert.equal(seitenZahl(buf), 3);
  assert.ok(/MediaBox \[0 0 595\.28 841\.89\]/.test(buf.toString('latin1')));
  assert.ok(buf.length < 200 * 1024);
});

// ── Beraterin-Routen ─────────────────────────────────────────────────────────
let app, tok, id, mailsVorher;
test.before(async () => {
  await H.setupBase();
  const R = require('../routes/schnelltest');
  await require('../lib/schemaRedesign').ensureSchema();
  app = await H.startApp([['/api/schnelltests', R.makeAdvisorRouter()]]);
  tok = H.advisorToken();
  const k = A.berechneKennzahlen(TEXT);
  const kand = [1, 2, 3, 4, 5].map(KAND);
  const r = await pool.query(`INSERT INTO schnelltests (url, host, email, kandidaten, kennzahlen, gesamteindruck, staerken, mehrseiten_gelesen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    ['https://muster.ch/', 'muster.ch', 'firma@muster.ch', JSON.stringify(kand), JSON.stringify(k), 'Gesamteindruck.', JSON.stringify([{ titel: 'S', text: 'T' }]), 3]);
  id = r.rows[0].id;
});
test.after(async () => { await app.close(); });

test('nur die Beraterin kommt an die Schnelltests', async () => {
  assert.equal((await app.call('GET', '/api/schnelltests')).status, 401);
  assert.equal((await app.call('GET', '/api/schnelltests', { token: H.clientToken(1) })).status, 403);
  const l = await app.call('GET', '/api/schnelltests', { token: tok });
  assert.equal(l.status, 200);
  assert.equal(l.body.schnelltests[0].status, 'entwurf');
});

test('Detail enthält Kandidaten, Kennzahlen und eine Begleitmail im Du-freien Sie-Ton mit Schluss von Lorena', async () => {
  const d = await app.call('GET', '/api/schnelltests/' + id, { token: tok });
  assert.equal(d.status, 200);
  assert.equal(d.body.kandidaten.length, 5);
  assert.ok(d.body.kennzahlen.woerterProSatz > 0);
  assert.match(d.body.begleitmail.text, /^Guten Tag/);
  assert.match(d.body.begleitmail.text, /Herzlich\nLorena Lienhard$/);
  assert.ok(!/[–—]/.test(d.body.begleitmail.text));
  assert.equal((await app.call('GET', '/api/schnelltests/99999', { token: tok })).status, 404);
});

test('Auswahl: höchstens drei, nur vorhandene, Status wechselt zwischen entwurf und freigegeben', async () => {
  const put = (b) => app.call('PUT', '/api/schnelltests/' + id, { token: tok, body: b });
  assert.equal((await put({ auswahl: ['k1', 'k2', 'k3', 'k4'] })).status, 400);
  assert.equal((await put({ auswahl: ['k1', 'zz'] })).status, 400);
  let r = await put({ auswahl: ['k1', 'k2'] });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'entwurf');
  r = await put({ auswahl: ['k3', 'k1', 'k2'], lorena_notiz: 'Meine Einschätzung.' });
  assert.equal(r.body.status, 'freigegeben');
  assert.deepEqual(r.body.auswahl, ['k3', 'k1', 'k2']);
  assert.equal(r.body.lorena_notiz, 'Meine Einschätzung.');
  r = await put({ auswahl: ['k1'] });
  assert.equal(r.body.status, 'entwurf');
  await put({ auswahl: ['k1', 'k2', 'k3'] });
});

test('Karten sind bearbeitbar, das Zitat bleibt, leere Felder und identischer Vorschlag werden abgelehnt', async () => {
  const put = (b) => app.call('PUT', '/api/schnelltests/' + id, { token: tok, body: b });
  let r = await put({ kandidaten: [{ id: 'k1', titel: 'Neuer Titel', nachher: 'Ein neuer Vorschlag von Lorena.', beleg: 'manipuliert', vorher: 'manipuliert' }] });
  assert.equal(r.status, 200);
  const k1 = r.body.kandidaten.find(c => c.id === 'k1');
  assert.equal(k1.titel, 'Neuer Titel');
  assert.equal(k1.beleg, ZEILEN[0]); assert.equal(k1.vorher, ZEILEN[0]);
  assert.equal((await put({ kandidaten: [{ id: 'k1', warum: '  ' }] })).status, 400);
  assert.equal((await put({ kandidaten: [{ id: 'k1', nachher: ZEILEN[0] }] })).status, 400);
  await put({ kandidaten: [{ id: 'k1', nachher: 'Ein neuer Vorschlag von Lorena.' }] });
});

test('PDF-Vorschau liefert ein PDF mit drei Seiten, ohne Auswahl 409', async () => {
  const r = await app.call('GET', '/api/schnelltests/' + id + '/pdf', { token: tok, raw: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(seitenZahl(buf), 3);
  await pool.query(`INSERT INTO schnelltests (url, host, email, kandidaten) VALUES ('https://leer.ch','leer.ch','a@leer.ch',$1)`, [JSON.stringify([KAND(1)])]);
  const leer = (await pool.query(`SELECT id FROM schnelltests WHERE host='leer.ch'`)).rows[0].id;
  assert.equal((await app.call('GET', '/api/schnelltests/' + leer + '/pdf', { token: tok })).status, 409);
});

test('Versand: genau drei nötig, sendet PDF-Anhang an die Firma, setzt gesendet, nur einmal', async () => {
  const leer = (await pool.query(`SELECT id FROM schnelltests WHERE host='leer.ch'`)).rows[0].id;
  const mail = { betreff: 'Ihr Test «Wie klingt Ihre Firma?» für muster.ch', text: 'Guten Tag\n\nHier ist Ihre Auswertung.\n\nHerzlich\nLorena Lienhard' };
  assert.equal((await app.call('POST', '/api/schnelltests/' + leer + '/senden', { token: tok, body: mail })).status, 400, 'ohne Auswahl');
  assert.equal((await app.call('POST', '/api/schnelltests/' + id + '/senden', { token: tok, body: { betreff: '', text: '' } })).status, 400, 'ohne Mailtext');
  H.mails.length = 0;
  const r = await app.call('POST', '/api/schnelltests/' + id + '/senden', { token: tok, body: mail });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'gesendet');
  assert.ok(r.body.gesendet_am);
  assert.equal(H.mails.length, 1);
  const m = H.mails[0];
  assert.equal(m.kind, 'schnelltest_kunde'); assert.equal(m.to, 'firma@muster.ch'); assert.equal(m.subject, mail.betreff);
  assert.equal(m.text, mail.text);
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].name, /^RhetorIQ_Wie-klingt-Ihre-Firma_muster\.ch\.pdf$/);
  assert.equal(Buffer.from(m.attachments[0].contentBase64, 'base64').slice(0, 4).toString(), '%PDF');
  assert.equal((await app.call('POST', '/api/schnelltests/' + id + '/senden', { token: tok, body: mail })).status, 409, 'kein zweiter Versand');
  assert.equal(H.mails.length, 1);
  assert.equal((await app.call('PUT', '/api/schnelltests/' + id, { token: tok, body: { auswahl: ['k1'] } })).status, 409, 'nach dem Senden gesperrt');
});

test('Zu lange Texte: Vorschau meldet mehr als drei Seiten, Versand wird abgelehnt und der Status bleibt', async () => {
  const w = (n) => ('Wort '.repeat(300)).slice(0, n);
  const lang = [1, 2, 3].map(i => ({ ...KAND(i), titel: w(200), warum: w(1000), nachher: w(600), wirkung: w(500), aha: w(320), beleg: ZEILEN[0], vorher: ZEILEN[0] }));
  const r = await pool.query(`INSERT INTO schnelltests (url, host, email, kandidaten, auswahl, status, lorena_notiz) VALUES ('https://l.ch','l.ch','x@l.ch',$1,$2,'freigegeben',$3) RETURNING id`, [JSON.stringify(lang), JSON.stringify(['k1', 'k2', 'k3']), w(1500)]);
  const pdf = await app.call('GET', '/api/schnelltests/' + r.rows[0].id + '/pdf', { token: tok, raw: true });
  assert.ok(Number(pdf.headers.get('x-seiten')) > 3);
  H.mails.length = 0;
  const s = await app.call('POST', '/api/schnelltests/' + r.rows[0].id + '/senden', { token: tok, body: { betreff: 'Betreff', text: 'Guten Tag, hier Ihre Auswertung.' } });
  assert.equal(s.status, 409);
  assert.equal(H.mails.length, 0);
  assert.equal((await pool.query('SELECT status FROM schnelltests WHERE id=$1', [r.rows[0].id])).rows[0].status, 'freigegeben');
});

test('Fehler beim Versand setzt den Status zurück', async () => {
  const kand = [1, 2, 3].map(KAND);
  const r = await pool.query(`INSERT INTO schnelltests (url, host, email, kandidaten, auswahl, status) VALUES ('https://f.ch','f.ch','x@f.ch',$1,$2,'freigegeben') RETURNING id`, [JSON.stringify(kand), JSON.stringify(['k1', 'k2', 'k3'])]);
  H.setMailFail(true);
  const s = await app.call('POST', '/api/schnelltests/' + r.rows[0].id + '/senden', { token: tok, body: { betreff: 'Betreff', text: 'Guten Tag, hier Ihre Auswertung.' } });
  H.setMailFail(false);
  assert.equal(s.status, 500);
  const row = (await pool.query('SELECT status, gesendet_am FROM schnelltests WHERE id=$1', [r.rows[0].id])).rows[0];
  assert.equal(row.status, 'freigegeben'); assert.equal(row.gesendet_am, null);
});

test('Schema ist idempotent und enthält die neuen Spalten', async () => {
  await require('../lib/schemaRedesign').ensureSchema();
  const row = (await pool.query('SELECT * FROM schnelltests LIMIT 1')).rows[0];
  for (const c of ['kandidaten', 'kennzahlen', 'gesamteindruck', 'staerken', 'auswahl', 'lorena_notiz', 'status', 'gesendet_am', 'mehrseiten_gelesen']) assert.ok(c in row, c);
});

test('Hinweis-Mail an Lorena nennt Firma, Kennzahlen, Kandidaten und den Link', () => {
  const M = require('../lib/schnelltestMails');
  const k = A.berechneKennzahlen(TEXT);
  const m = M.hinweisMail({ id: 7, url: 'https://muster.ch/', host: 'muster.ch', email: 'a@b.ch', kennzahlen: k, kandidaten: [KAND(1), { ...KAND(2), automatisch: true }], mehrseiten: 3 });
  assert.match(m.subject, /muster\.ch/);
  for (const w of ['https://muster.ch/', 'a@b.ch', 'Wörter pro Satz', 'Floskeln:', '1. [Satzbau]', '2. [Satzbau, automatisch]', '/#schnelltest-7', 'Hallo Lorena', 'Du']) assert.ok(m.text.includes(w), w);
  assert.ok(!/[–—]/.test(m.text));
});
