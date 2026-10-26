// Seitenpaket-Generator: Lauf im Hintergrund, Rechte, Kontingent, Import, Fehlerfälle, Word-Export und Gesamtprüfung.
// KI-Attrappe (H.ai) und simulierter Abruf, keine Netzzugriffe.
process.env.ABO_PFLICHT_AB = '2099-01-01T00:00:00Z';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = H;
const { DataType } = require('pg-mem');
H.mem.public.registerFunction({ name: 'date_trunc', args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz, implementation: (u, t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } });

let srv, a, b, c, see, WP, viewerId;
const adv = () => H.advisorToken();
const FAKTEN = {
  strasse: 'Seestrasse 12', plz: '6003', ort: 'Luzern', telefon: '+41 41 123 45 67', kueche: 'Saisonale Schweizer Küche',
  reservation_url: 'https://seeblick.example/reservation', oeffnungszeiten: [{ tage: ['Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], von: '11:00', bis: '23:00' }]
};

// Antwort der Attrappe im verlangten Format; der Seitentyp steht in der ersten Zeile des Auftrags
function antwort(opts, extra = '') {
  const msg = opts.messages[0].content;
  const label = (/SEITENTYP: (.+)/.exec(msg) || [])[1] || 'Seite';
  return `TITEL: ${label} im Seeblick Luzern\nBESCHREIBUNG: Das Restaurant Seeblick in Luzern serviert saisonale Schweizer Küche am See, mit Terrasse und Reservation online möglich.\nH1: ${label} in Luzern\nTEXT:\nDie Abendsonne liegt auf dem Wasser und auf dem Tisch duftet es nach frischem Brot. ${extra}\nH2: Was Sie erwartet\nWir kochen mit Zutaten aus der Region und decken den Tisch für Sie.\nFAQ:\nF: Kann ich reservieren?\nA: Ja, online über die Reservationsseite.\n`;
}
async function warten(id) {
  await WP.warteBis(id);
  return (await srv.call('GET', `/api/webseiten/paket/${id}`, { token: adv() })).body;
}

test.before(async () => {
  await H.setupBase();
  await setupGenerate(H);
  await require('../lib/schemaRedesign').ensureSchema();
  await pool.query('CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, model TEXT, cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())').catch(() => {});
  for (const col of ['capital_markets_enabled BOOLEAN DEFAULT FALSE', 'hotel_enabled BOOLEAN DEFAULT FALSE']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  a = await H.addClient('Segmüller Collection');
  b = await H.addClient('Andere AG');
  c = await H.addClient('Ohne Restaurants AG');
  for (const k of [a, b]) await pool.query('UPDATE clients SET enabled_modules=$1 WHERE id=$2', [['brand-voice', 'text-gen', 'restaurants'], k.id]);
  await pool.query(`INSERT INTO company_memory (client_id, memory_type, content) VALUES ($1,'brand_voice','Wir sind herzlich und gradlinig.')`, [a.id]);
  require('../lib/costAlerts').check = async () => {};   // Kostenwarnung braucht echtes Postgres, hier nicht Thema
  for (const col of ['email TEXT', 'name TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  viewerId = (await pool.query(`INSERT INTO client_users (client_id, email, name, role) VALUES ($1,'v@x.ch','V','viewer') RETURNING id`, [a.id])).rows[0].id;
  WP = require('../lib/webseitenPaket');
  srv = await H.startApp([
    ['/api/einheiten', require('../routes/einheiten')],
    ['/api/webseiten', require('../routes/webseiten')]
  ]);
  see = (await srv.call('POST', '/api/einheiten', { token: adv(), body: { clientId: a.id, name: 'Restaurant Seeblick', ort: 'Luzern', stimme: 'Ruhig und warm.', faktenStruktur: FAKTEN } })).body;
  H.ai.reply = (opts) => antwort(opts);
});
test.after(async () => { await srv.close(); });

test('Seitentypen, Seitensätze und Faktenfelder', async () => {
  const r = await srv.call('GET', '/api/webseiten/seitentypen', { token: adv() });
  assert.equal(r.status, 200);
  assert.ok(r.body.seitentypen.find(t => t.key === 'startseite' && Array.isArray(t.laengeWoerter)));
  assert.ok(Array.isArray(r.body.seitensaetze.restaurant_klein));
  assert.ok(r.body.faktenFelder.length > 5);
  assert.equal((await srv.call('GET', '/api/webseiten/seitentypen')).status, 401);
});

test('Paket mit drei Seitentypen läuft durch, in der Reihenfolge, mit Fakten nur aus dem Faktenblatt', async () => {
  H.ai.calls.length = 0;
  const typen = ['startseite', 'mittag', 'faq'];
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: typen, stichworte: { mittag: 'Business Lunch ab 12 Uhr' } } });
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'laeuft');
  assert.equal(r.body.gesamt, 3);
  const p = await warten(r.body.id);
  assert.equal(p.status, 'fertig');
  assert.equal(p.fertig, 3);
  assert.equal(p.einheitName, 'Restaurant Seeblick');
  assert.deepEqual(p.seiten.map(s => s.typ), typen);
  assert.ok(p.seiten.every(s => s.status === 'fertig' && s.titel && s.h1 && s.text && s.faq.length === 1));
  assert.deepEqual(p.seiten[0].h2, ['Was Sie erwartet']);
  // Auf einen Blick und JSON-LD kommen aus den Fakten
  assert.ok(p.seiten[0].aufEinenBlick.find(z => z.label === 'Adresse' && z.wert === 'Seestrasse 12, 6003 Luzern'));
  const ld = JSON.parse(p.seiten[0].jsonld);
  assert.ok(Array.isArray(ld) && ld.some(x => x['@type'] === 'FAQPage'));
  assert.equal(ld[0].address.streetAddress, 'Seestrasse 12');
  // Der Auftrag enthält Fakten, Stichworte, Stimme des Kunden und des Restaurants und die Stilregeln
  assert.equal(H.ai.calls.length, 3);
  const sys = require('../test-support/genSetup').systemText(H.ai.calls.find(x => /Mittag|SEITENTYP/.test(x.messages[0].content)));
  assert.match(sys, /herzlich und gradlinig/);
  assert.match(sys, /Ruhig und warm/);
  assert.match(sys, /Seestrasse 12/);
  const mittag = H.ai.calls.find(x => /Business Lunch/.test(x.messages[0].content));
  assert.ok(mittag);
  // Verlauf und Verbrauch: je Seite ein Eintrag
  const { rows } = await pool.query(`SELECT input_data, feedback_key FROM analyses WHERE client_id=$1 AND module='text-gen'`, [a.id]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(x => Number(x.input_data.einheitId) === see.id && x.feedback_key === 'text-gen-website'));
  // Verbrauch: jeder Aufruf trägt Modul text-gen und den Kunden (die Zählung selbst geschieht in lib/meter.js)
  assert.ok(H.ai.calls.every(x => x.meter && x.meter.module === 'text-gen' && x.meter.clientId === a.id));
  // Liste
  const l = await srv.call('GET', `/api/webseiten/pakete?clientId=${a.id}`, { token: adv() });
  assert.equal(l.body[0].id, r.body.id);
  assert.equal(l.body[0].status, 'fertig');
});

test('Rechte: Opt-in-Modul, fremder Kunde, fremdes Restaurant, Betrachter, Ansicht', async () => {
  H.ai.calls.length = 0;
  const body = { clientId: a.id, einheitId: see.id, seitentypen: ['startseite'] };
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { ...body, clientId: c.id } })).status, 403, 'Modul fehlt');
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: H.clientToken(b.id), body })).status, 403, 'Restaurant gehört einem anderen Kunden');
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: H.clientToken(b.id), body: { ...body, clientId: b.id } })).status, 403);
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: H.clientToken(a.id, { clientUserId: viewerId, clientUserRole: 'viewer' }), body })).status, 403, 'Betrachter');
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: H.clientToken(a.id, { readOnly: true }), body })).status, 403, 'Ansicht');
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { ...body, seitentypen: ['gibtsnicht'] } })).status, 400);
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id } })).status, 400);
  assert.equal((await srv.call('POST', '/api/webseiten/paket')).status, 401);
  assert.equal(H.ai.calls.length, 0);
  // Lesen: fremder Kunde sieht nichts, Betrachter darf lesen
  const l = await srv.call('GET', `/api/webseiten/pakete?clientId=${a.id}`, { token: H.clientToken(b.id) });
  assert.equal(l.body.length, 0);
  const { rows } = await pool.query('SELECT id FROM webseiten_pakete WHERE client_id=$1 LIMIT 1', [a.id]);
  assert.equal((await srv.call('GET', `/api/webseiten/paket/${rows[0].id}`, { token: H.clientToken(b.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/webseiten/paket/${rows[0].id}`, { token: H.clientToken(a.id, { clientUserId: viewerId, clientUserRole: 'viewer' }) })).status, 200);
});

test('Kontingent: Überschreitung wie bei der normalen Erzeugung, keine KI-Aufrufe', async () => {
  H.ai.calls.length = 0;
  await pool.query('UPDATE clients SET monthly_token_limit=$1 WHERE id=$2', [8000, a.id]);
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['startseite', 'mittag', 'faq'] } });
  assert.equal(r.status, 429);
  assert.equal(r.body.quotaExceeded, true);
  assert.equal(H.ai.calls.length, 0);
  await pool.query('UPDATE clients SET monthly_token_limit=NULL WHERE id=$1', [a.id]);
});

test('Import: bestehender Text wird überarbeitet, Abruf simuliert', async () => {
  const alt = WP.abruf.seiteLesen;
  const abgerufen = [];
  WP.abruf.seiteLesen = async (url) => { abgerufen.push(url); return { url, titel: 'Alt', h1: ['Alt'], h2: [], text: 'Unser alter Mittagstext mit Pasta und Salat.', woerter: 8 }; };
  H.ai.calls.length = 0;
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['mittag', 'faq'], importUrls: { mittag: 'https://seeblick.example/mittag/', hochzeit: 'https://x.example/' } } });
  assert.equal(r.status, 202);
  const p = await warten(r.body.id);
  WP.abruf.seiteLesen = alt;
  assert.equal(p.status, 'fertig');
  assert.deepEqual(abgerufen, ['https://seeblick.example/mittag/']);
  assert.equal(H.ai.calls.filter(x => /BESTEHENDER TEXT/.test(x.messages[0].content) && /alter Mittagstext/.test(x.messages[0].content)).length, 1);
  assert.equal(H.ai.calls.filter(x => /BESTEHENDER TEXT/.test(x.messages[0].content)).length, 1, 'nur die Seite mit Adresse wird überarbeitet');
  assert.equal((await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['mittag'], importUrls: { mittag: 'ftp://x' } } })).status, 400);
});

test('Import-Routen: Liste mit erkanntem Typ zuerst, Seite lesen', async () => {
  const s1 = WP.abruf.sitemapSeiten, s2 = WP.abruf.seiteLesen;
  WP.abruf.sitemapSeiten = async () => [{ url: 'https://x.example/kontakt-xyz/', pfad: '/kontakt-xyz' }, { url: 'https://x.example/', pfad: '/' }, { url: 'https://x.example/mittag/', pfad: '/mittag' }];
  WP.abruf.seiteLesen = async (url) => ({ url, titel: 'T', text: 'Inhalt' });
  const l = await srv.call('POST', '/api/webseiten/import/liste', { token: adv(), body: { url: 'https://x.example' } });
  const s = await srv.call('POST', '/api/webseiten/import/seite', { token: adv(), body: { url: 'https://x.example/mittag/' } });
  WP.abruf.sitemapSeiten = s1; WP.abruf.seiteLesen = s2;
  assert.equal(l.status, 200);
  assert.equal(l.body.seiten.length, 3);
  assert.ok(l.body.seiten[0].typ && l.body.seiten[0].label);
  assert.equal(l.body.seiten[2].typ, null);
  assert.equal(s.body.text, 'Inhalt');
  assert.equal((await srv.call('POST', '/api/webseiten/import/liste', { token: adv(), body: {} })).status, 400);
});

test('Fehler bei einer Seite ergibt «teilweise», die übrigen Seiten laufen weiter', async () => {
  H.ai.reply = (opts) => { if (/SEITENTYP: Häufige Fragen/.test(opts.messages[0].content)) throw new Error('KI kaputt'); return antwort(opts); };
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['startseite', 'faq', 'mittag'] } });
  const p = await warten(r.body.id);
  H.ai.reply = (opts) => antwort(opts);
  assert.equal(p.status, 'teilweise');
  assert.deepEqual(p.seiten.map(s => s.status), ['fertig', 'fehler', 'fertig']);
  assert.ok(p.seiten[1].fehler);
  assert.equal(p.fertig, 3);
});

test('Falsche Fakten der KI landen nie im Auf einen Blick und erscheinen als Abweichung', async () => {
  H.ai.reply = (opts) => antwort(opts, 'Sie finden uns an der Bahnhofstrasse 99, 6003 Luzern, Telefon 041 999 88 77.');
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['ueber_uns'] } });
  const p = await warten(r.body.id);
  H.ai.reply = (opts) => antwort(opts);
  const s = p.seiten[0];
  assert.equal(s.status, 'fertig');
  assert.equal(s.qualitaet.ok, false);
  assert.ok(s.qualitaet.hinweise.some(h => h.art === 'fakten'), 'Konflikt in qualitaet');
  assert.ok(!JSON.stringify(s.aufEinenBlick).includes('Bahnhofstrasse'));
  assert.ok(!s.jsonld.includes('Bahnhofstrasse') && !s.jsonld.includes('999'));
  assert.ok(s.jsonld.includes('Seestrasse 12'));
  const chk = await srv.call('GET', `/api/webseiten/check?clientId=${a.id}`, { token: adv() });
  assert.ok(chk.body.konflikte.length >= 1);
});

test('Word-Export liefert eine gültige docx', async () => {
  const { rows } = await pool.query(`SELECT id FROM webseiten_pakete WHERE client_id=$1 AND status='fertig' ORDER BY id LIMIT 1`, [a.id]);
  const r = await srv.call('GET', `/api/webseiten/paket/${rows[0].id}/export.docx`, { token: adv(), raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
  if (AdmZip) {
    const xml = new AdmZip(buf).readAsText('word/document.xml');
    assert.match(xml, /Auf einen Blick/);
    assert.match(xml, /JSON-LD/);
    assert.match(xml, /Seestrasse 12/);
  }
  assert.equal((await srv.call('GET', `/api/webseiten/paket/${rows[0].id}/export.docx`, { token: H.clientToken(b.id) })).status, 403);
});

test('Check findet Duplikate bei zwei fast gleichen Texten', async () => {
  const gleich = 'Die Abendsonne liegt auf dem Wasser und auf dem Tisch duftet es nach frischem Brot. Wir kochen mit Zutaten aus der Region und decken den Tisch für Sie mit viel Liebe zum Detail. Jeder Gast erhält zuerst ein Glas Wein aus dem Keller und danach ein Menü aus drei Gängen, das unsere Küche jeden Tag frisch zusammenstellt.';
  H.ai.reply = (opts) => antwort(opts, gleich);
  const r = await srv.call('POST', '/api/webseiten/paket', { token: adv(), body: { clientId: a.id, einheitId: see.id, seitentypen: ['bar_wein', 'bankette'] } });
  await warten(r.body.id);
  H.ai.reply = (opts) => antwort(opts);
  const chk = await srv.call('GET', `/api/webseiten/check?clientId=${a.id}`, { token: adv() });
  assert.equal(chk.status, 200);
  assert.ok(chk.body.anzahlSeiten >= 2);
  assert.ok(chk.body.duplikate.length >= 1, 'Duplikate erkannt');
  assert.equal((await srv.call('GET', `/api/webseiten/check?clientId=${a.id}`, { token: H.clientToken(b.id) })).status, 200, 'Klient sieht nur den eigenen Kunden');
  assert.equal((await srv.call('GET', `/api/webseiten/check?clientId=${c.id}`, { token: adv() })).status, 403);
});

test('Lange laufende Pakete ohne Fortschritt gelten als unterbrochen', async () => {
  const { rows } = await pool.query(`INSERT INTO webseiten_pakete (client_id, einheit_id, status, seiten, gesamt, updated_at) VALUES ($1,$2,'laeuft','[]',1, NOW() - INTERVAL '2 hours') RETURNING id`, [a.id, see.id]);
  const p = await srv.call('GET', `/api/webseiten/paket/${rows[0].id}`, { token: adv() });
  assert.equal(p.body.status, 'unterbrochen');
});
