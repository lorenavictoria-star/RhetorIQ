// Daten-Wächter: Erkennung mit Prüfziffern, Platzhalter-Rundlauf (auch im Stream), Modi an der KI-Schnittstelle,
// Rollenschutz der Route und ein Protokoll ohne Inhalt. Fetch-Attrappe, keine echten Aufrufe, keine echten Zugangsdaten.
process.env.ABO_PFLICHT_AB = '2099-01-01T00:00:00Z';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const dw = require('../lib/datenwaechter');
const { pool } = require('../db');

const AHV = '756.9217.0769.85';
const IBAN = 'CH93 0076 2011 6238 5295 7';
const KARTE = '4111 1111 1111 1111';
const MAIL = 'max.muster@beispiel.ch';
const typen = (t, opt) => dw.erkenne(t, opt || { typen: dw.ALLE_TYPEN }).map(f => f.typ);

test('AHV-Nummer: gültige Prüfziffer wird erkannt, ungültige und lose Zahlen nicht', () => {
  assert.deepEqual(typen(`Meine AHV ${AHV} bitte`), ['AHV']);
  assert.deepEqual(typen('AHV 7569217076985'), ['AHV']);
  assert.deepEqual(typen('AHV 756.9217.0769.86'), []);
  assert.deepEqual(typen('Bestellnummer 756 1234 5678 90'), []);
});

test('IBAN: CH und LI mit Mod-97, mit und ohne Leerzeichen; falsche Prüfsumme nicht', () => {
  assert.deepEqual(typen(`IBAN ${IBAN}`), ['IBAN']);
  assert.deepEqual(typen('IBAN CH9300762011623852957'), ['IBAN']);
  assert.deepEqual(typen('LI21 0881 0000 2324 013A A'), ['IBAN']);
  assert.deepEqual(typen('IBAN CH94 0076 2011 6238 5295 7'), []);
  assert.deepEqual(typen('CH93 hat nichts zu bedeuten'), []);
});

test('Kreditkarte: Luhn, 16 Ziffern oder gruppiert; Zufallszahlen nicht', () => {
  assert.deepEqual(typen(`Karte ${KARTE}`), ['KREDITKARTE']);
  assert.deepEqual(typen('Karte 4111111111111111'), ['KREDITKARTE']);
  assert.deepEqual(typen('Karte 4111 1111 1111 1112'), []);
  assert.deepEqual(typen('Rechnung 20240315123456'), []);
});

test('Keine Fehlalarme bei Datum, Postleitzahl, Preis, Jahreszahl und Prozent', () => {
  const t = 'Am 12.03.2024 um 8001 Zürich, Preis CHF 1\'234.50, Seminar 2025, 15 % Rabatt, Rechnung Nr. 20240312, 3.5 Stunden, Telefonat 14.30 Uhr.';
  assert.deepEqual(dw.erkenne(t, { typen: dw.ALLE_TYPEN }), []);
  assert.deepEqual(dw.erkenne('Normaler Satz ohne Besonderheiten.', {}), []);
});

test('E-Mail, Telefon und UID', () => {
  assert.deepEqual(typen(`Schreib an ${MAIL}.`), ['EMAIL']);
  assert.deepEqual(typen('Tel +41 31 123 45 67'), ['TELEFON']);
  assert.deepEqual(typen('Tel 031 123 45 67'), ['TELEFON']);
  assert.deepEqual(typen('Tel +41 (0)79 123 45 67'), ['TELEFON']);
  assert.deepEqual(typen('Tel 099 123 45 67'), []);
  assert.deepEqual(typen('Firma CHE-116.281.710 MWST'), ['UID']);
  assert.deepEqual(typen('Firma CHE-116.281.711'), []);
});

test('Passwörter und Schlüssel, Geburtsdatum nur bei Schlüsselwort, Name nur wenn aktiviert', () => {
  assert.deepEqual(typen('Passwort: Geheim123!'), ['SCHLUESSEL']);
  assert.deepEqual(typen('Passwort: ***'), []);
  assert.deepEqual(typen('Schlüssel sk-ant-api03-abcdefghijklmnop1234'), ['SCHLUESSEL']);
  assert.deepEqual(typen('Key pk_live_abcdefghij1234'), ['SCHLUESSEL']);
  assert.deepEqual(typen('Authorization: Bearer abcdefghijklmnop12345678'), ['SCHLUESSEL']);
  assert.deepEqual(typen('Frau Muster ist geboren am 14.03.1985.'), ['NAME', 'GEBURTSDATUM']);
  assert.deepEqual(typen('Jahrgang 1972'), ['GEBURTSDATUM']);
  assert.deepEqual(typen('Der Termin ist am 14.03.1985 gewesen.'), []);
  assert.deepEqual(typen('Herr Keller und Frau Dr. Muster'), ['NAME', 'NAME']);
  assert.deepEqual(typen('Herr Keller', undefined), ['NAME']);
  assert.deepEqual(dw.erkenne('Herr Keller'), [], 'Name ist in der Vorgabe nicht aktiv');
});

test('Funde tragen Position, Schwere und Platzhalter; gleiche Werte teilen den Platzhalter', () => {
  const t = `A ${MAIL} B ${MAIL} C ${IBAN} D ${IBAN.replace(/ /g, '')}`;
  const f = dw.erkenne(t);
  assert.deepEqual(f.map(x => x.platzhalter), ['[E-MAIL-1]', '[E-MAIL-1]', '[IBAN-1]', '[IBAN-1]']);
  assert.equal(t.slice(f[0].start, f[0].ende), MAIL);
  assert.equal(f[2].schwere, 'hoch');
  assert.equal(dw.erkenne('x a@b.ch y c@d.ch')[1].platzhalter, '[E-MAIL-2]');
});

test('ersetzen und Rückweg: Platzhalter-Rundlauf, andere Modi lassen den Text unverändert', () => {
  const t = `Konto ${IBAN}, Mail ${MAIL}, nochmals ${MAIL}, Tel 031 123 45 67.`;
  const r = dw.schuetze(t, 'ersetzen');
  assert.equal(r.text, 'Konto [IBAN-1], Mail [E-MAIL-1], nochmals [E-MAIL-1], Tel [TELEFON-1].');
  assert.equal(dw.stelleWiederHer(r.text, r.abbild), t);
  assert.equal(dw.schuetze(t, 'warnen').text, t);
  assert.equal(dw.schuetze(t, 'sperren').text, t);
  assert.equal(dw.stelleWiederHer('Fremd [IBAN-9] bleibt', r.abbild), 'Fremd [IBAN-9] bleibt');
  const ohne = 'Ein ganz normaler Text mit [Klammern] und 8001 Zürich.';
  assert.equal(dw.schuetze(ohne, 'ersetzen').text, ohne);
});

test('Streaming-Puffer setzt auch über Chunk-Grenzen geteilte Platzhalter zurück', () => {
  const t = `Konto ${IBAN} und ${MAIL}`;
  const r = dw.schuetze(t, 'ersetzen');
  const antwort = 'Ich habe [IBAN-1] und [E-MAIL-1] geprüft. Ein [Hinweis] bleibt. Ende [IBAN-1]';
  const erwartet = `Ich habe ${IBAN} und ${MAIL} geprüft. Ein [Hinweis] bleibt. Ende ${IBAN}`;
  for (const schritt of [1, 2, 3, 5, 7, 100]) {
    const rw = dw.neuerRueckwandler(r.abbild);
    let aus = '';
    for (let i = 0; i < antwort.length; i += schritt) aus += rw.push(antwort.slice(i, i + schritt));
    aus += rw.ende();
    assert.equal(aus, erwartet, 'Schrittweite ' + schritt);
  }
  const rw = dw.neuerRueckwandler(r.abbild);
  assert.equal(rw.push('Offen [IBA') + rw.ende(), 'Offen [IBA', 'unvollständiger Platzhalter geht am Ende nicht verloren');
});

test('Maskierte Vorschau zeigt nie den vollen Wert', () => {
  assert.equal(dw.maskiere('AHV', AHV), '756.••••.••••.••');
  assert.ok(!dw.maskiere('IBAN', IBAN).includes('0076'));
  assert.ok(!dw.maskiere('EMAIL', MAIL).includes('muster'));
  assert.ok(!dw.maskiere('KREDITKARTE', KARTE).includes('4111 1111'));
});

// ── Schnittstelle und Route ─────────────────────────────────────────────────
let ai, store, meter, srv, client, gesendet;
const realFetch = global.fetch;
function sse(teile) {
  const zeilen = teile.map(t => `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`).join('')
    + `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`;
  return zeilen;
}
let antwortModus = 'json', antwortText = 'ok', streamTeile = [];

test.before(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-nur-fuer-attrappe';
  await H.setupBase();
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  // die echte Schnittstelle laden (das Testgerüst ersetzt sie sonst durch eine Attrappe)
  delete require.cache[require.resolve('../lib/aiProvider')];
  ai = require('../lib/aiProvider');
  ai._cfg.waits = [0, 0];
  store = require('../lib/datenwaechterStore');
  meter = require('../lib/meter');
  require('../lib/costAlerts').check = async () => {};
  require('../lib/abo').pruefeSchwellen = async () => {};   // braucht Spalten, die hier nicht Thema sind
  client = await H.addClient('Wächter AG');
  gesendet = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    gesendet.push(JSON.parse(opts.body));
    if (antwortModus === 'stream') {
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse(streamTeile))); c.close(); } }) };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ text: antwortText }], usage: { input_tokens: 3, output_tokens: 2 } }) };
  };
  srv = await H.startApp([['/api/datenwaechter', require('../routes/datenwaechter')]]);
});
test.after(async () => { global.fetch = realFetch; await srv.close(); });

const frage = (text, extra = {}) => ai.generateText({ system: 'Sys', messages: [{ role: 'user', content: text }], maxTokens: 50, model: 'claude-haiku-4-5-20251001', ...extra });
const setze = (modus, t = dw.STANDARD_TYPEN) => store.speichereEinstellungen({ modus, typen: t });
const imAlltag = (fn) => meter.run({ advisorId: 1, clientId: client.id }, fn);

test('Standard für neue Installationen ist «warnen»', async () => {
  store.cacheLeeren();
  const e = await store.holeEinstellungen();
  assert.equal(e.modus, 'warnen');
  assert.ok(e.typen.includes('IBAN') && !e.typen.includes('NAME'));
});

test('warnen und aus: der Text geht unverändert raus; ohne Funde bleibt alles unverändert', async () => {
  for (const m of ['warnen', 'aus']) {
    await setze(m);
    gesendet.length = 0;
    await imAlltag(() => frage(`Bitte an ${MAIL} schreiben`));
    assert.equal(gesendet[0].messages[0].content, `Bitte an ${MAIL} schreiben`);
    assert.equal(gesendet[0].system[0].text, 'Sys');
  }
  await setze('ersetzen');
  gesendet.length = 0;
  const normal = 'Ein Text ohne sensible Angaben, 8001 Zürich, am 12.03.2024.';
  await imAlltag(() => frage(normal));
  assert.equal(gesendet[0].messages[0].content, normal);
  assert.equal(gesendet[0].system.length, 1, 'kein Hinweis im System-Prompt ohne Funde');
});

test('ersetzen: Platzhalter gehen raus, System-Prompt bekommt den Hinweis, die Antwort wird zurückgesetzt', async () => {
  await setze('ersetzen');
  gesendet.length = 0;
  antwortModus = 'json'; antwortText = 'Erledigt für [E-MAIL-1] und [IBAN-1].';
  const r = await imAlltag(() => frage(`Mail ${MAIL}, Konto ${IBAN}`, { messages: [{ role: 'user', content: [{ type: 'text', text: `Mail ${MAIL}` }, { type: 'document', source: { type: 'text', media_type: 'text/plain', data: `Konto ${IBAN}` } }] }] }));
  const roh = JSON.stringify(gesendet[0]);
  assert.ok(!roh.includes(MAIL) && !roh.includes('0076'), 'kein Fundwert beim Anbieter');
  assert.ok(roh.includes('[E-MAIL-1]') && roh.includes('[IBAN-1]'));
  assert.ok(gesendet[0].system.some(b => /Platzhalter in eckigen Klammern/.test(b.text)));
  assert.equal(r.text, `Erledigt für ${MAIL} und ${IBAN}.`);
});

test('ersetzen im Stream: geteilte Platzhalter kommen vollständig zurück', async () => {
  await setze('ersetzen');
  gesendet.length = 0;
  antwortModus = 'stream'; streamTeile = ['Gern. [E-M', 'AIL-1] und [IB', 'AN-1', '] sind da.'];
  let aus = '';
  await imAlltag(async () => { for await (const e of ai.streamText({ system: 'S', messages: [{ role: 'user', content: `Mail ${MAIL}, Konto ${IBAN}` }], maxTokens: 50, model: 'claude-haiku-4-5-20251001' })) if (e.type === 'text') aus += e.text; });
  assert.equal(aus, `Gern. ${MAIL} und ${IBAN} sind da.`);
  assert.ok(!JSON.stringify(gesendet[0]).includes(MAIL));
  antwortModus = 'json';
});

test('Kopfzeile verschärft einen einzelnen Aufruf von «warnen» auf «ersetzen», lockert aber nie', async () => {
  await setze('warnen');
  gesendet.length = 0;
  await meter.run({ advisorId: 1, clientId: client.id, dwErsetzen: true }, () => frage(`Mail ${MAIL}`));
  assert.ok(!JSON.stringify(gesendet[0]).includes(MAIL));
  await setze('sperren');
  await assert.rejects(meter.run({ advisorId: 1, clientId: client.id, dwErsetzen: true }, () => frage(`Mail ${MAIL}`)), e => e.status === 422);
  const req = { headers: { 'x-daten-waechter': 'ersetzen' }, body: {}, query: {}, params: {} };
  assert.equal(meter.contextFromRequest(req, { role: 'advisor', id: 1 }).dwErsetzen, true);
  assert.equal(meter.contextFromRequest({ ...req, headers: {} }, { role: 'advisor', id: 1 }).dwErsetzen, undefined);
});

test('sperren: Fehler 422 mit Fundtypen, nichts geht an den Anbieter, Meldung ohne Fundwerte', async () => {
  await setze('sperren');
  gesendet.length = 0;
  await assert.rejects(imAlltag(() => frage(`Konto ${IBAN} Mail ${MAIL}`)), (e) => {
    assert.equal(e.status, 422);
    assert.deepEqual(e.datenwaechter.typen.sort(), ['EMAIL', 'IBAN']);
    assert.ok(!e.message.includes(MAIL) && !e.message.includes('0076') && !JSON.stringify(e.datenwaechter).includes('0076'));
    return true;
  });
  assert.equal(gesendet.length, 0);
  // Stream ebenso
  await assert.rejects(imAlltag(async () => { for await (const _ of ai.streamText({ messages: [{ role: 'user', content: `AHV ${AHV}` }], maxTokens: 5, model: 'x' })); }), e => e.status === 422);
  assert.equal(gesendet.length, 0);
  // Ohne Funde läuft alles normal
  const ok = await imAlltag(() => frage('Harmloser Text'));
  assert.equal(ok.text, antwortText);
});

test('sperren in Hintergrundaufträgen ohne Person wirkt als «ersetzen» (es gibt niemanden, der warnen könnte)', async () => {
  await setze('sperren');
  gesendet.length = 0;
  await frage(`Mail ${MAIL}`);
  assert.equal(gesendet.length, 1);
  assert.ok(!JSON.stringify(gesendet[0]).includes(MAIL));
});

test('aktive Typen: nicht aktivierte Typen werden nicht angefasst', async () => {
  await setze('ersetzen', ['IBAN']);
  gesendet.length = 0;
  await imAlltag(() => frage(`Mail ${MAIL}, Konto ${IBAN}`));
  const roh = JSON.stringify(gesendet[0]);
  assert.ok(roh.includes(MAIL) && !roh.includes('0076'));
});

test('Protokoll enthält nur Zeit, Klient, Modus, Typ und Anzahl, nie einen Wert', async () => {
  const { rows } = await pool.query('SELECT * FROM datenwaechter_log');
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['anzahl', 'client_id', 'id', 'modus', 'typ', 'zeit']);
  const alles = JSON.stringify(rows);
  for (const w of [MAIL, '0076', AHV, '4111', 'beispiel']) assert.ok(!alles.includes(w), 'Wert im Protokoll: ' + w);
  assert.ok(rows.some(r => r.modus === 'sperren' && r.typ === 'IBAN'));
  assert.ok(rows.some(r => r.modus === 'ersetzen' && r.typ === 'EMAIL' && r.client_id === client.id));
});

test('Route: prüfen für Beraterin und Klient, nur maskierte Vorschau, Eingaben werden geprüft', async () => {
  await setze('warnen');
  const text = `Konto ${IBAN} und ${MAIL}, nochmals ${MAIL}`;
  for (const token of [H.advisorToken(), H.clientToken(client.id)]) {
    const r = await srv.call('POST', '/api/datenwaechter/pruefen', { token, body: { text } });
    assert.equal(r.status, 200);
    assert.equal(r.body.modus, 'warnen');
    assert.deepEqual(r.body.funde.map(f => [f.typ, f.anzahl]), [['IBAN', 1], ['EMAIL', 2]]);
    assert.ok(!JSON.stringify(r.body).includes('0076') && !JSON.stringify(r.body).includes('beispiel.ch'));
    assert.match(r.body.funde[0].vorschau, /^CH93 •+/);
  }
  assert.equal((await srv.call('POST', '/api/datenwaechter/pruefen', { body: { text } })).status, 401);
  assert.equal((await srv.call('POST', '/api/datenwaechter/pruefen', { token: H.advisorToken(), body: {} })).status, 400);
  assert.equal((await srv.call('POST', '/api/datenwaechter/pruefen', { token: H.advisorToken(), body: { text: 'a'.repeat(100001) } })).status, 413);
  const leer = await srv.call('POST', '/api/datenwaechter/pruefen', { token: H.advisorToken(), body: { text: 'Nur ein Satz.' } });
  assert.deepEqual(leer.body.funde, []);
  await setze('aus');
  assert.deepEqual((await srv.call('POST', '/api/datenwaechter/pruefen', { token: H.advisorToken(), body: { text } })).body, { modus: 'aus', funde: [] });
});

test('Route: Einstellungen und Auswertung nur für die Beraterin, Eingaben werden geprüft', async () => {
  const c = H.clientToken(client.id), a = H.advisorToken();
  for (const [m, u] of [['GET', '/api/datenwaechter/einstellungen'], ['PUT', '/api/datenwaechter/einstellungen'], ['GET', '/api/datenwaechter/auswertung']]) {
    assert.equal((await srv.call(m, u, { token: c, body: m === 'PUT' ? { modus: 'aus', typen: [] } : undefined })).status, 403, m + ' ' + u);
    assert.equal((await srv.call(m, u, { body: m === 'PUT' ? { modus: 'aus', typen: [] } : undefined })).status, 401);
  }
  const put = await srv.call('PUT', '/api/datenwaechter/einstellungen', { token: a, body: { modus: 'ersetzen', typen: ['IBAN', 'AHV'] } });
  assert.equal(put.status, 200);
  const get = await srv.call('GET', '/api/datenwaechter/einstellungen', { token: a });
  assert.equal(get.body.modus, 'ersetzen');
  assert.deepEqual(get.body.typen, ['IBAN', 'AHV']);
  assert.ok(get.body.alleTypen.some(t => t.typ === 'NAME') && get.body.modi.includes('sperren'));
  assert.equal((await srv.call('PUT', '/api/datenwaechter/einstellungen', { token: a, body: { modus: 'kaputt', typen: [] } })).status, 400);
  assert.equal((await srv.call('PUT', '/api/datenwaechter/einstellungen', { token: a, body: { modus: 'aus', typen: ['GIBTSNICHT'] } })).status, 400);
  const au = await srv.call('GET', '/api/datenwaechter/auswertung', { token: a });
  assert.equal(au.status, 200);
  assert.equal(au.body.tage, 30);
  assert.ok(au.body.total >= 3 && au.body.nachTyp.some(t => t.typ === 'IBAN' && t.anzahl >= 1));
  assert.ok(!JSON.stringify(au.body).includes('0076'));
});

test('Aufbewahrung: Protokolleinträge älter als 90 Tage werden vom Löschjob entfernt', async () => {
  await pool.query(`INSERT INTO datenwaechter_log (zeit, client_id, modus, typ, anzahl) VALUES (NOW() - INTERVAL '100 days', NULL, 'warnen', 'IBAN', 1)`);
  const vorher = (await pool.query('SELECT COUNT(*)::int AS n FROM datenwaechter_log')).rows[0].n;
  const n = await store.loescheAlt();
  assert.ok(n >= 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM datenwaechter_log')).rows[0].n, vorher - n);
  assert.ok(require('fs').readFileSync(require.resolve('../lib/retention'), 'utf8').includes('datenwaechterStore'));
});
