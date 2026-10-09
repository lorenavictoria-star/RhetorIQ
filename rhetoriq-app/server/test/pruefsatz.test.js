// Prüfsatz mit Blindvergleich: Ablauf, Kostenobergrenze, Mischung, Auswertung, Zugriff. KI ist eine Attrappe.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { setupGenerate } = require('../test-support/genSetup');
const { pool } = require('../db');
const meter = require('../lib/meter');
const ps = require('../lib/pruefsatz');

let srv, a, b;
const TXT = i => `Bitte eine freundliche Einladung zum Kundenanlass Nummer ${i} formulieren, mit Datum und Ort im Briefing.`;

async function auftraege(clientId, n) {
  for (let i = 1; i <= n; i++) await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, input_data, feedback_key, result) VALUES ($1,1,'text-gen',$2,'text-gen-email','alt')`, [clientId, JSON.stringify({ text: TXT(i), tile: 'email' })]);
}
// Attrappe: jeder Aufruf kostet etwas im Kostenprotokoll (wie aiProvider es täte). Draft und Revision unterscheidbar.
let kostenProAufruf = 1000, aufrufe = [];
function ki() {
  H.ai.reply = async (opts) => {
    const revision = JSON.stringify(opts.messages).includes('ENTWURF (erster Versuch)');
    aufrufe.push(revision ? 'revision' : 'erst');
    await meter.record({ model: 'claude-sonnet-4-6', inputTokens: kostenProAufruf, outputTokens: 100 });
    return revision ? 'Überarbeiteter Text. ' + 'Wir freuen uns sehr auf Ihren Besuch. '.repeat(3) : 'Direkter Text. ' + 'Wir freuen uns sehr auf Ihren Besuch. '.repeat(3);
  };
}

test.before(async () => {
  require('../lib/costAlerts').check = async () => {};   // Kostenwarnung braucht echtes Postgres (date_trunc), hier nicht Thema
  await H.setupBase();
  await setupGenerate(H);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  a = await H.addClient('Alpha AG'); b = await H.addClient('Beta AG');
  await auftraege(a.id, 12);
  await auftraege(b.id, 3);
  srv = await H.startApp([['/api/pruefsatz', require('../routes/pruefsatz')]]);
  ki();
});
test.after(async () => { await srv.close(); });

const warte = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } return null; };
const lauf = id => srv.call('GET', `/api/pruefsatz/lauf/${id}`, { token: H.advisorToken() });

test('Vorschau: höchstens 10 Briefings, Schätzung in Franken, ohne KI-Aufruf', async () => {
  H.ai.calls.length = 0;
  const r = await srv.call('GET', `/api/pruefsatz/vorschau/${a.id}`, { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.equal(r.body.anzahl, 10);
  assert.deepEqual(r.body.varianten.map(v => v.key), ['A', 'B']);
  assert.ok(r.body.schaetzung.chf > 0 && r.body.schaetzung.usd <= 3);
  assert.equal(r.body.schaetzung.aufrufe, 30);   // 10 Aufträge, A mit zwei Durchgängen, B mit einem
  assert.equal(H.ai.calls.length, 0);
});

test('Start nur mit ausdrücklicher Bestätigung und nur für eigene Klienten', async () => {
  assert.equal((await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: a.id } })).status, 400);
  assert.equal((await srv.call('POST', '/api/pruefsatz/start', { token: H.clientToken(a.id), body: { clientId: a.id, bestaetigt: true } })).status, 403);
  assert.equal((await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: 9999, bestaetigt: true } })).status, 403);
  assert.equal((await srv.call('GET', `/api/pruefsatz/vorschau/${a.id}`, { token: H.clientToken(a.id) })).status, 403);
});

test('Ablauf: Hintergrundlauf, kein Eintrag in analyses, Kostenprotokoll mit Modul pruefsatz', async () => {
  const vorher = (await pool.query('SELECT COUNT(*)::int AS n FROM analyses')).rows[0].n;
  kostenProAufruf = 1000; aufrufe = [];
  const s = await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: a.id, bestaetigt: true } });
  assert.equal(s.status, 202);
  const fertig = await warte(async () => { const r = await lauf(s.body.id); return r.body.status === 'bewertung' ? r.body : null; });
  assert.ok(fertig, 'Lauf fertig');
  assert.equal(fertig.fortschritt.fertig, 10);
  assert.equal(fertig.auftraege.length, 10);
  assert.equal(aufrufe.length, 30);
  assert.equal(aufrufe.filter(x => x === 'revision').length, 10);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM analyses')).rows[0].n, vorher);
  const u = (await pool.query('SELECT module, COUNT(*)::int AS n FROM usage_log GROUP BY module')).rows;
  assert.deepEqual(u, [{ module: 'pruefsatz', n: 30 }]);
  assert.ok(fertig.kostenUsd > 0);
  // Anonym: weder Schlüssel noch Namen der Varianten in der Ansicht
  assert.ok(!/"[AB]"|Standard|ohne zweiten|reihenfolge/.test(JSON.stringify(fertig.auftraege)));
  assert.equal(fertig.auswertung, undefined);
  global.__lauf = fertig;
  global.__id = s.body.id;
});

test('Blindvergleich: Mischung, Wahl je Auftrag, Auswertung erst nach der letzten Wahl', async () => {
  const id = global.__id;
  // Alle zehn Aufträge bewerten: je Position wählen; die Zuordnung steht nur in der Datenbank
  const { rows } = await pool.query('SELECT ergebnis FROM pruefsatz_laeufe WHERE id=$1', [id]);
  const e = rows[0].ergebnis;
  // Reihenfolge ist gemischt: nicht überall steht A zuerst (bei 10 Aufträgen praktisch sicher)
  const ersteA = e.auftraege.filter(x => x.reihenfolge[0] === 'A').length;
  assert.ok(ersteA > 0 && ersteA < 10, 'Mischung: ' + ersteA);
  let siegeA = 0;
  for (const a of e.auftraege) {
    // Beraterin wählt immer den Text mit zweitem Durchgang (Variante A) bei Aufträgen 1 bis 6, bei 7 bis 8 B, bei 9 gleich, 10 offen
    let w;
    if (a.nr <= 6) { w = a.reihenfolge.indexOf('A'); siegeA++; }
    else if (a.nr <= 8) w = a.reihenfolge.indexOf('B');
    else if (a.nr === 9) w = 'gleich';
    else continue;
    const r = await srv.call('POST', `/api/pruefsatz/lauf/${id}/wahl`, { token: H.advisorToken(), body: { nr: a.nr, wahl: w } });
    assert.equal(r.status, 200);
    assert.equal(r.body.auswertung, undefined, 'Auswertung erst nach der letzten Wahl');
  }
  assert.equal((await srv.call('POST', `/api/pruefsatz/lauf/${id}/wahl`, { token: H.advisorToken(), body: { nr: 10, wahl: 7 } })).status, 400);
  const last = await srv.call('POST', `/api/pruefsatz/lauf/${id}/wahl`, { token: H.advisorToken(), body: { nr: 10, wahl: e.auftraege[9].reihenfolge.indexOf('B') } });
  assert.equal(last.body.status, 'ausgewertet');
  const au = last.body.auswertung;
  assert.equal(au.bewertet, 10);
  assert.equal(au.gleich, 1);
  assert.deepEqual(au.varianten.map(v => [v.key, v.siege]), [['A', 6], ['B', 3]]);
  assert.match(au.satz, /Standard 6 von 10, ohne zweiten Durchgang 3 von 10, gleich 1/);
  // Fremde Beraterin ohne Zugriff, Klient ohne Zugriff
  assert.equal((await srv.call('GET', `/api/pruefsatz/lauf/${id}`, { token: H.clientToken(a.id) })).status, 403);
  const li = await srv.call('GET', `/api/pruefsatz/liste/${a.id}`, { token: H.advisorToken() });
  assert.equal(li.body.laeufe.length, 1);
});

test('Kostenobergrenze von 3 US-Dollar bricht den Lauf ab', async () => {
  await pool.query('DELETE FROM usage_log');
  kostenProAufruf = 66667;   // rund 0.20 US-Dollar je Aufruf, 0.60 je Auftrag
  aufrufe = [];
  const s = await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: a.id, bestaetigt: true } });
  assert.equal(s.status, 202);
  const fertig = await warte(async () => { const r = await lauf(s.body.id); return r.body.status !== 'laeuft' ? r.body : null; }, 8000);
  assert.equal(fertig.status, 'bewertung' === fertig.status ? 'bewertung' : 'abgebrochen');
  assert.equal(fertig.status, 'abgebrochen');
  assert.match(fertig.abbruchGrund, /3 US-Dollar/);
  assert.ok(fertig.fortschritt.fertig < 10 && fertig.fortschritt.fertig >= 4, 'abgebrochen nach ' + fertig.fortschritt.fertig);
  assert.ok(fertig.kostenUsd <= 3.3, 'Kosten ' + fertig.kostenUsd);
  assert.ok(fertig.auftraege.length === fertig.fortschritt.fertig);
});

test('zu wenig Aufträge, Lauf für Klienten ohne Briefings', async () => {
  const s = await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: b.id, bestaetigt: true } });
  assert.equal(s.status, 202);   // 3 Briefings reichen für einen Lauf
  const c = await H.addClient('Leer AG');
  const l = await srv.call('POST', '/api/pruefsatz/start', { token: H.advisorToken(), body: { clientId: c.id, bestaetigt: true } });
  assert.equal(l.status, 400);
  assert.equal(ps.mische(['A', 'B', 'C'], (lo, hi) => lo).length, 3);
});
