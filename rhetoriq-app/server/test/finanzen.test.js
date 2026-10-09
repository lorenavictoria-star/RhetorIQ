const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { pool } = require('../db');
const fin = require('../lib/finanzen');

const M = '2026-10', V = '2026-09';
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const item = (o) => ({ id: 'c' + Math.random(), month: M, refundedCents: 0, feeCents: 100, meta: {}, interval: null, intervalCount: 1, ...o });
const base = (o) => ({ month: M, clients: [{ id: 1, name: 'Alpha AG' }, { id: 2, name: 'Beta AG' }], items: [], mehraufwand: {}, kiRows: [], fixkosten: [], einstellungen: {}, gebuchtChf: null, quelle: 'stripe', ...o });
const zeile = (b, key) => b.einnahmen.gruppen.flatMap(g => g.zeilen).find(z => z.key === key);

test('Einnahmen nach Kategorien, Anzahl Klienten und Summe', () => {
  const b = fin.compute(base({ items: [
    item({ amountCents: 19000, interval: 'month', meta: { clientId: '1', angebot: 'stimme' } }),
    item({ amountCents: 59000, interval: 'month', meta: { clientId: '2' } }),
    item({ amountCents: 15000, interval: 'month', meta: { clientId: '2', type: 'themenplan' } }),
    item({ amountCents: 29000, interval: 'month', intervalCount: 3, meta: { clientId: '1', type: 'quartalsreview' } }),
    item({ amountCents: 4900, meta: { clientId: '1', type: 'topup' } }),
    item({ amountCents: 69000, meta: { clientId: '1', type: 'karte' } }),
    item({ amountCents: 95000, meta: { clientId: '2', type: 'einrichtung', angebot: 'stimm-audit' } }),
    item({ amountCents: 390000, meta: { clientId: '2', type: 'einrichtung', angebot: 'workshop-team' } })
  ], mehraufwand: { 1: 135 } }));
  assert.equal(zeile(b, 'abo_stimme').betragChf, 190);
  assert.equal(zeile(b, 'abo_team').betragChf, 590);
  assert.equal(zeile(b, 'abo_business').anzahl, 0);
  assert.equal(zeile(b, 'themenplan').betragChf, 150);
  assert.equal(zeile(b, 'quartalsreview').betragChf, 290);
  assert.equal(zeile(b, 'topup').betragChf, 49);
  assert.equal(zeile(b, 'karte').betragChf, 690);
  assert.equal(zeile(b, 'audit').betragChf, 950);
  assert.equal(zeile(b, 'workshop_team').betragChf, 3900);
  assert.equal(zeile(b, 'beratung').betragChf, 135);
  assert.equal(b.einnahmen.summeChf, 190 + 590 + 150 + 290 + 49 + 690 + 950 + 3900 + 135);
  assert.equal(b.kennzahlen.zahlendeKlienten, 2);
});

test('Zuordnung nach Betrag ohne Angaben, Unbekanntes landet bei Nicht zugeordnet', () => {
  const b = fin.compute(base({ items: [
    item({ amountCents: 149000, interval: 'month' }),
    item({ amountCents: 500000 }),
    item({ amountCents: 12345 })
  ] }));
  assert.equal(zeile(b, 'abo_business').betragChf, 1490);
  assert.equal(zeile(b, 'workshop_business').betragChf, 5000);
  assert.equal(zeile(b, 'nicht_zugeordnet').betragChf, 123.45);
  assert.ok(b.hinweise.some(h => /keiner Kategorie/.test(h)));
  assert.equal(b.einnahmen.summeChf, 1490 + 5000 + 123.45);
});

test('Rückerstattung wird abgezogen', () => {
  const b = fin.compute(base({ items: [item({ amountCents: 59000, refundedCents: 20000, interval: 'month', meta: { clientId: '1', angebot: 'team' } })] }));
  assert.equal(b.einnahmen.rueckerstattungenChf, -200);
  assert.equal(b.einnahmen.summeChf, 390);
  assert.equal(b.klienten[0].einnahmenChf, 390);
});

test('Jahresabo zählt im Zahlungsmonat voll, MRR teilt durch 12', () => {
  const b = fin.compute(base({ items: [item({ amountCents: 637200, interval: 'year', meta: { clientId: '1' } }), item({ amountCents: 19000, interval: 'month', meta: { clientId: '2' } })] }));
  assert.equal(zeile(b, 'abo_team').betragChf, 6372);
  assert.equal(b.einnahmen.summeChf, 6562);
  assert.equal(b.kennzahlen.mrrChf, 531 + 190);
  assert.equal(b.kennzahlen.arrChf, (531 + 190) * 12);
});

test('Mehrwertsteuer netto und brutto', () => {
  const items = [item({ amountCents: 108100, interval: 'month', meta: { clientId: '1', angebot: 'business' } })];
  const n = fin.compute(base({ items, einstellungen: { mwst_pflichtig: true, mwst_satz: 8.1, mwst_anzeige: 'netto' } }));
  assert.equal(n.einnahmen.summeChf, 1000);
  assert.equal(n.einnahmen.mwst.betragChf, 81);
  assert.match(n.einnahmen.mwst.text, /netto/);
  const br = fin.compute(base({ items, einstellungen: { mwst_pflichtig: true, mwst_satz: 8.1, mwst_anzeige: 'brutto' } }));
  assert.equal(br.einnahmen.summeChf, 1081);
  assert.equal(br.einnahmen.mwst.betragChf, 81);
  const aus = fin.compute(base({ items }));
  assert.equal(aus.einnahmen.summeChf, 1081);
  assert.equal(aus.einnahmen.mwst.pflichtig, false);
});

test('Fixkosten: gültig ab und bis, einmalig, variable Kosten', () => {
  const fixkosten = [
    { id: 1, name: 'Render', betrag_chf: 25, art: 'fix', wiederkehrend: true, gueltig_ab: '2026-01', gueltig_bis: null },
    { id: 2, name: 'Alt', betrag_chf: 99, art: 'fix', wiederkehrend: true, gueltig_ab: '2025-01', gueltig_bis: '2026-09' },
    { id: 3, name: 'Spaeter', betrag_chf: 10, art: 'fix', wiederkehrend: true, gueltig_ab: '2026-11', gueltig_bis: null },
    { id: 4, name: 'Einmalig', betrag_chf: 40, art: 'fix', wiederkehrend: false, gueltig_ab: '2026-10', gueltig_bis: null },
    { id: 5, name: 'Einmalig alt', betrag_chf: 40, art: 'fix', wiederkehrend: false, gueltig_ab: '2026-09', gueltig_bis: null },
    { id: 6, name: 'AssemblyAI', betrag_chf: 12.5, art: 'variabel', wiederkehrend: true, gueltig_ab: null, gueltig_bis: null }
  ];
  const b = fin.compute(base({ fixkosten }));
  assert.equal(b.kosten.fix.summeChf, 65);
  assert.equal(b.kosten.variable.summeChf, 12.5);
  assert.deepEqual(b.kosten.fix.posten.map(p => p.name), ['Render', 'Einmalig']);
});

test('Ergebnis, Marge, KI-Kosten, gebuchte Anthropic-Rechnung, Rückstellung, Gebühren', () => {
  const items = [item({ amountCents: 100000, feeCents: null, interval: 'month', meta: { clientId: '1', angebot: 'business' } })];
  const kiRows = [{ clientId: 1, module: 'mail', usd: 11 }, { clientId: 1, module: 'rede', usd: 11 }, { clientId: null, module: 'chat', usd: 11 }];
  const b = fin.compute(base({ items, kiRows, einstellungen: { wechselkurs: 1.1, rueckstellung_prozent: 20 }, fixkosten: [{ id: 1, name: 'X', betrag_chf: 100, art: 'fix', wiederkehrend: true }] }));
  assert.equal(b.kosten.ki.berechnetChf, 30);
  assert.equal(b.kosten.stripeGebuehren.betragChf, 29.3);
  assert.equal(b.kosten.stripeGebuehren.geschaetzt, true);
  assert.equal(b.kosten.summeChf, 30 + 29.3 + 100);
  assert.equal(b.ergebnisChf, 1000 - 159.3);
  assert.equal(b.margeProzent, 84.1);
  assert.equal(b.kiProzentVomUmsatz, 3);
  assert.equal(b.rueckstellung.betragChf, 168.14);
  assert.equal(b.klienten.find(k => k.clientId === 1).kiKostenChf, 20);
  const g = fin.compute(base({ items, kiRows, einstellungen: { wechselkurs: 1.1 }, gebuchtChf: 60 }));
  assert.equal(g.kosten.ki.verwendetChf, 60);
  assert.equal(g.kosten.ki.berechnetChf, 30);
  assert.equal(g.klienten.find(k => k.clientId === 1).kiKostenChf, 40, 'gebuchter Wert verteilt sich im Verhältnis');
});

test('Klumpenrisiko über 40 Prozent und Top 5', () => {
  const b = fin.compute(base({ items: [item({ amountCents: 59000, interval: 'month', meta: { clientId: '1' } }), item({ amountCents: 19000, interval: 'month', meta: { clientId: '2' } })] }));
  assert.equal(b.kennzahlen.klumpenrisiko.length, 1);
  assert.equal(b.kennzahlen.klumpenrisiko[0].name, 'Alpha AG');
  assert.equal(b.kennzahlen.top5.length, 2);
});

test('Zahlungen fremder Klienten zählen nicht', () => {
  const b = fin.compute(base({ items: [item({ amountCents: 59000, interval: 'month', meta: { clientId: '99' } })] }));
  assert.equal(b.einnahmen.summeChf, 0);
  assert.ok(b.hinweise.some(h => /anderer Beraterinnen/.test(h)));
});

test('Schweizer Zahlenformat', () => {
  assert.equal(fin.chf(1234.5), "CHF 1'234.50");
  assert.equal(fin.chf(-1234567.05), "CHF -1'234'567.05");
});

// ── Route, Datenbank, Stripe-Attrappe ──
let srv, a, b2, other, stripeCalls = 0, stripeFail = false;
const mkStripe = () => ({
  charges: { list: async () => {
    stripeCalls++;
    if (stripeFail) throw new Error('Netzwerk weg');
    return { has_more: false, data: [
      { id: 'ch1', status: 'succeeded', paid: true, currency: 'chf', amount: 59000, amount_refunded: 0, created: sec('2026-10-05T10:00:00Z'), metadata: {}, payment_intent: 'pi1', balance_transaction: { fee: 1741, currency: 'chf' }, invoice: { id: 'in1', metadata: {}, subscription_details: { metadata: { clientId: String(a.id) } }, lines: { data: [{ metadata: {}, price: { recurring: { interval: 'month', interval_count: 1 } } }] } } },
      { id: 'ch2', status: 'succeeded', paid: true, currency: 'chf', amount: 4900, amount_refunded: 0, created: sec('2026-10-06T10:00:00Z'), metadata: {}, payment_intent: 'pi2', balance_transaction: null, invoice: null },
      { id: 'ch3', status: 'succeeded', paid: true, currency: 'chf', amount: 19000, amount_refunded: 0, created: sec('2026-10-07T10:00:00Z'), metadata: { clientId: String(other.id) }, balance_transaction: { fee: 600, currency: 'chf' }, invoice: null },
      { id: 'ch4', status: 'failed', paid: false, currency: 'chf', amount: 19000, created: sec('2026-10-08T10:00:00Z'), metadata: {} },
      { id: 'ch5', status: 'succeeded', paid: true, currency: 'chf', amount: 59000, amount_refunded: 0, created: sec('2026-09-05T10:00:00Z'), metadata: { clientId: String(a.id), angebot: 'team' }, balance_transaction: { fee: 1000, currency: 'chf' }, invoice: null }
    ] };
  } },
  checkout: { sessions: { list: async () => ({ has_more: false, data: [{ id: 's2', payment_intent: 'pi2', metadata: { clientId: String(b2.id), type: 'topup' } }] }) } }
});

test.before(async () => {
  await H.setupBase();
  await pool.query('ALTER TABLE clients ADD COLUMN monthly_token_limit INTEGER').catch(() => {});
  await pool.query("ALTER TABLE clients ADD COLUMN subscription_status TEXT DEFAULT 'trial'").catch(() => {});
  await pool.query('ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT').catch(() => {});
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT, input_tokens BIGINT DEFAULT 0, output_tokens BIGINT DEFAULT 0, model TEXT, cache_creation_tokens BIGINT DEFAULT 0, cache_read_tokens BIGINT DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO users (email, name) VALUES ('andere@test.ch', 'Andere')`);
  a = await H.addClient('Alpha AG'); b2 = await H.addClient('Beta AG');
  const { rows } = await pool.query(`INSERT INTO clients (advisor_id, name, slug, token) VALUES (2,'Fremd AG','fremd','tokfremd') RETURNING id`);
  other = rows[0];
  await pool.query(`UPDATE clients SET subscription_status='active', monthly_token_limit=750000 WHERE id=$1`, [a.id]);
  await pool.query(`UPDATE clients SET subscription_status='trial' WHERE id=$1`, [b2.id]);
  await pool.query(`INSERT INTO usage_log (advisor_id, client_id, module, cost_usd, created_at) VALUES (1,$1,'mail',5.5,'2026-10-10T10:00:00Z'),(1,$1,'rede',5.5,'2026-10-11T10:00:00Z'),(2,$2,'mail',50,'2026-10-11T10:00:00Z'),(1,NULL,'chat',1.1,'2026-10-12T10:00:00Z')`, [a.id, other.id]);
  srv = await H.startApp([['/api/finanzen', require('../routes/finanzen')]]);
  require('../routes/finanzen').__setStripe(mkStripe());
});
test.after(async () => { await srv.close(); });

test('Klient erhält 403, ohne Anmeldung 401', async () => {
  assert.equal((await srv.call('GET', `/api/finanzen?month=${M}`, { token: H.clientToken(a.id) })).status, 403);
  assert.equal((await srv.call('GET', `/api/finanzen?month=${M}`)).status, 401);
  assert.equal((await srv.call('PUT', '/api/finanzen/einstellungen', { token: H.clientToken(a.id), body: {} })).status, 403);
  assert.equal((await srv.call('POST', '/api/finanzen/fixkosten', { token: H.clientToken(a.id), body: { name: 'x', betrag_chf: 1 } })).status, 403);
});

test('Bericht aus Stripe: Kategorien, Gebühren, Kliententrennung, KI-Kosten, Vergleich', async () => {
  const r = await srv.call('GET', `/api/finanzen?month=${M}`, { token: H.advisorToken() });
  assert.equal(r.status, 200);
  const bd = r.body;
  assert.equal(bd.schaetzung, false);
  const z = k => bd.einnahmen.gruppen.flatMap(g => g.zeilen).find(x => x.key === k);
  assert.equal(z('abo_team').betragChf, 590);
  assert.equal(z('topup').betragChf, 49, 'Sitzungsangaben ordnen die Einmalzahlung zu');
  assert.equal(bd.einnahmen.summeChf, 639, 'Zahlung des fremden Klienten fehlt');
  assert.equal(bd.kosten.stripeGebuehren.betragChf, 17.41 + Math.round(4900 * 0.029 + 30) / 100);
  assert.equal(bd.kosten.stripeGebuehren.geschaetzt, true);
  assert.equal(bd.kosten.ki.berechnetUsd, 12.1, 'Nutzung des fremden Klienten fehlt');
  assert.equal(bd.vergleich.einnahmen.vormonat, 590);
  assert.equal(bd.klienten.find(k => k.clientId === a.id).kiKostenChf, 10);
  assert.equal(bd.klienten.find(k => k.clientId === b2.id).einnahmenChf, 49);
  const calls = stripeCalls;
  await srv.call('GET', `/api/finanzen?month=${M}`, { token: H.advisorToken() });
  assert.equal(stripeCalls, calls, 'Zwischenspeicher: kein zweiter Stripe-Aufruf');
});

test('Einstellungen, Fixkosten, Anthropic-Rechnung speichern und wirken', async () => {
  const t = H.advisorToken();
  assert.equal((await srv.call('PUT', '/api/finanzen/einstellungen', { token: t, body: { mwst_satz: 99 } })).status, 400);
  assert.equal((await srv.call('PUT', '/api/finanzen/einstellungen', { token: t, body: { mwst_pflichtig: true, mwst_satz: 8.1, mwst_anzeige: 'netto', wechselkurs: 1.2, rueckstellung_prozent: 10 } })).status, 200);
  const n = await srv.call('POST', '/api/finanzen/fixkosten', { token: t, body: { name: 'Render', betrag_chf: 25, art: 'fix', wiederkehrend: true, gueltig_ab: '2026-01' } });
  assert.equal(n.status, 200);
  assert.equal((await srv.call('POST', '/api/finanzen/fixkosten', { token: t, body: { name: '', betrag_chf: 5 } })).status, 400);
  assert.equal((await srv.call('POST', '/api/finanzen/fixkosten', { token: t, body: { name: 'Falsch', betrag_chf: 5, gueltig_ab: '2026-05', gueltig_bis: '2026-01' } })).status, 400);
  assert.equal((await srv.call('PUT', '/api/finanzen/anthropic', { token: t, body: { month: M, betragChf: 20 } })).status, 200);
  let bd = (await srv.call('GET', `/api/finanzen?month=${M}`, { token: t })).body;
  assert.equal(bd.kosten.fix.summeChf, 25);
  assert.equal(bd.kosten.ki.wechselkurs, 1.2);
  assert.equal(bd.kosten.ki.verwendetChf, 20);
  assert.equal(bd.kosten.ki.mitGebuchtemWert, true);
  assert.equal(bd.einnahmen.mwst.pflichtig, true);
  assert.equal(bd.einnahmen.summeChf, Math.round(63900 / 1.081) / 100);
  assert.equal(bd.rueckstellung.prozent, 10);
  const list = (await srv.call('GET', '/api/finanzen/fixkosten', { token: t })).body;
  assert.equal(list.length, 1);
  assert.equal((await srv.call('PUT', `/api/finanzen/fixkosten/${list[0].id}`, { token: t, body: { name: 'Render Pro', betrag_chf: 30 } })).status, 200);
  assert.equal((await srv.call('GET', `/api/finanzen/fixkosten`, { token: t })).body[0].betrag_chf, 30);
  assert.equal((await srv.call('DELETE', `/api/finanzen/fixkosten/${list[0].id}`, { token: t })).status, 200);
  assert.equal((await srv.call('DELETE', `/api/finanzen/fixkosten/${list[0].id}`, { token: t })).status, 404);
  await srv.call('PUT', '/api/finanzen/anthropic', { token: t, body: { month: M, betragChf: '' } });
  bd = (await srv.call('GET', `/api/finanzen?month=${M}`, { token: t })).body;
  assert.equal(bd.kosten.ki.mitGebuchtemWert, false);
  await srv.call('PUT', '/api/finanzen/einstellungen', { token: t, body: { mwst_pflichtig: false, rueckstellung_prozent: 0 } });
});

test('Stripe nicht erreichbar: Schätzung aus der Datenbank, deutlich gekennzeichnet', async () => {
  stripeFail = true; require('../routes/finanzen').__setStripe(mkStripe());
  const bd = (await srv.call('GET', `/api/finanzen?month=${M}`, { token: H.advisorToken() })).body;
  assert.equal(bd.schaetzung, true);
  assert.equal(bd.quelle, 'schaetzung');
  assert.ok(bd.hinweise[0].startsWith('Schätzung, nicht aus Stripe'));
  assert.equal(bd.einnahmen.gruppen.flatMap(g => g.zeilen).find(x => x.key === 'abo_team').betragChf, 590);
  assert.equal(bd.kosten.stripeGebuehren.geschaetzt, true);
  const csv = await srv.call('GET', `/api/finanzen/export.csv?month=${M}`, { token: H.advisorToken(), raw: true });
  stripeFail = false;
  assert.match(await csv.text(), /Schätzung, nicht aus Stripe/);
  require('../routes/finanzen').__setStripe(mkStripe());
});

test('Stripe nicht konfiguriert gibt ebenfalls eine Schätzung', async () => {
  require('../routes/finanzen').__setStripe(null);
  const old = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  const bd = (await srv.call('GET', `/api/finanzen?month=${M}`, { token: H.advisorToken() })).body;
  if (old) process.env.STRIPE_SECRET_KEY = old;
  assert.equal(bd.schaetzung, true);
  assert.match(bd.stripeHinweis, /nicht eingerichtet/);
  require('../routes/finanzen').__setStripe(mkStripe());
});

test('Export als CSV und Word', async () => {
  const r = await srv.call('GET', `/api/finanzen/export.csv?month=${M}`, { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /Finanzaufstellung-2026-10\.csv/);
  const t = await r.text();
  assert.match(t, /Ergebnis des Monats/);
  assert.match(t, /Summe Einnahmen/);
  assert.match(t, /Paket Team/);
  const d = await srv.call('GET', `/api/finanzen/export.docx?month=${M}`, { token: H.advisorToken(), raw: true });
  assert.equal(d.status, 200);
  const buf = Buffer.from(await d.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.equal((await srv.call('GET', `/api/finanzen/export.csv?month=${M}`, { token: H.clientToken(a.id), raw: true })).status, 403);
});
