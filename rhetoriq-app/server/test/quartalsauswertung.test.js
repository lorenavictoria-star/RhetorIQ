// Quartalsauswertung: Auswahl der Klienten, Idempotenz je Quartal, Mailversand (gemockt), Budget, Webhook-Flag, Kaufroute.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('../test-support/harness');
const { pool } = H;
const qa = require('../lib/quartalsauswertung');
const { runQuartalsauswertungJob } = require('../jobs/quartalsauswertung');
const subs = require('../routes/subscriptions');

const NOW = new Date('2026-10-02T07:00:00+02:00');
const Q = '2026-Q3';
let srv, subsSrv, biz, ent, team, teamAddon, stimme, cancelled, plain, links;
const KI = JSON.stringify({ zusammenfassung: 'Die Nutzung war stabil – mit Luft nach oben.', empfehlungen: ['Kontingent besprechen.', 'Nach dem Ziel für das nächste Quartal fragen.'] });

async function post(ev) {
  return fetch(`${subsSrv.base}/api/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig-ok' }, body: JSON.stringify(ev) });
}
const flag = async id => (await pool.query('SELECT quartalsreview_aktiv AS f, subscription_status AS s, monthly_token_limit AS l FROM clients WHERE id=$1', [id])).rows[0];
let evn = 0;

test.before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  await H.setupBase();
  for (const col of ['monthly_token_limit BIGINT', "subscription_status TEXT DEFAULT 'trial'", 'stripe_customer_id TEXT', 'included_minutes INTEGER']) await pool.query(`ALTER TABLE clients ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`CREATE TABLE usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens BIGINT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ, satz_meta JSONB)`);
  const { DataType } = require('pg-mem');
  try { H.mem.public.registerFunction({ name: 'date_trunc', args: [DataType.text, DataType.timestamptz], returns: DataType.timestamptz, implementation: (u, t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } }); } catch { /* schon registriert */ }
  await require('../lib/schemaRedesign').ensureSchema();
  biz = await H.addClient('Business AG'); ent = await H.addClient('Enterprise AG'); team = await H.addClient('Team AG');
  teamAddon = await H.addClient('Team Zusatz AG'); stimme = await H.addClient('Stimme AG'); cancelled = await H.addClient('Gekuendigt AG'); plain = await H.addClient('Ohne Paket AG');
  await pool.query('UPDATE clients SET monthly_token_limit=2000000 WHERE id=$1', [biz.id]);
  await pool.query(`UPDATE clients SET monthly_token_limit=NULL, recommended_plan='enterprise' WHERE id=$1`, [ent.id]);
  await pool.query('UPDATE clients SET monthly_token_limit=750000 WHERE id IN ($1,$2)', [team.id, teamAddon.id]);
  await pool.query('UPDATE clients SET quartalsreview_aktiv=TRUE WHERE id=$1', [teamAddon.id]);
  await pool.query('UPDATE clients SET monthly_token_limit=200000 WHERE id=$1', [stimme.id]);
  await pool.query(`UPDATE clients SET monthly_token_limit=2000000, subscription_status='cancelled' WHERE id=$1`, [cancelled.id]);
  await pool.query(`UPDATE clients SET salutation='Frau', last_name='Muster' WHERE id=$1`, [biz.id]);
  // Daten für das Business-Quartal
  await pool.query(`INSERT INTO analyses (client_id, advisor_id, module, module_label, result, created_at, user_rating) VALUES
    ($1,1,'m','LinkedIn-Beitrag','GEHEIMER TEXTINHALT','2026-08-10T10:00:00Z',1),
    ($1,1,'m','LinkedIn-Beitrag','Text','2026-09-10T10:00:00Z',NULL),
    ($1,1,'m','Newsletter','Text','2026-07-05T10:00:00Z',-1),
    ($1,1,'m','Newsletter','Alt','2026-05-05T10:00:00Z',NULL)`, [biz.id]);
  await pool.query(`INSERT INTO client_feedback_learnings (client_id, module_key, category, summary, updated_at, satz_meta) VALUES
    ($1,'text-gen','TON','Weniger Floskeln am Anfang. Keine Ausrufezeichen.', '2026-08-15T10:00:00Z', $2)`,
    [biz.id, JSON.stringify({ 'weniger floskeln am anfang.': { at: '2026-02-01T10:00:00Z', count: 4 }, 'keine ausrufezeichen.': { at: '2026-08-15T10:00:00Z', count: 1 } })]);
  H.ai.reply = KI;
  links = [];
  subs._setStripe({
    webhooks: { constructEvent: (body, sig, secret) => { if (sig !== 'sig-ok' || secret !== 'whsec_test') throw new Error('bad'); return JSON.parse(body.toString()); } },
    paymentLinks: { create: async (o) => { links.push(o); return { url: 'https://pay.test/qr' }; } }
  });
  const app = express();
  app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/api/subscriptions', subs);
  const server = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  subsSrv = {
    base, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
    call: async (method, url, { token, body } = {}) => {
      const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    }
  };
  srv = await H.startApp([['/api/quartalsreview', require('../routes/quartalsreview')]]);
});
test.after(async () => { await srv.close(); await subsSrv.close(); });

test('Quartal: am 2. Tag nach Quartalsende gilt das vorherige Quartal', () => {
  assert.equal(qa.vorherigesQuartal(new Date('2026-10-02T07:00:00+02:00')), '2026-Q3');
  assert.equal(qa.vorherigesQuartal(new Date('2027-01-02T07:00:00+01:00')), '2026-Q4');
  assert.equal(qa.vorherigesQuartal(new Date('2026-04-02T07:00:00+02:00')), '2026-Q1');
  assert.equal(qa.vorherigesQuartal(new Date('2026-07-02T07:00:00+02:00')), '2026-Q2');
});

test('Auswahl: Business, Enterprise und Zusatz; nicht Stimme, Team ohne Zusatz, Gekündigte, ohne Paket', async () => {
  const l = await qa.berechtigte();
  assert.deepEqual(l.map(c => c.name).sort(), ['Business AG', 'Enterprise AG', 'Team Zusatz AG']);
  assert.equal(l.find(c => c.name === 'Team Zusatz AG').grund, 'zusatz');
  assert.equal(l.find(c => c.name === 'Business AG').grund, 'paket');
});

test('Kennzahlen: nur vorhandene Daten, KI-Eingabe ohne Namen und Textinhalte', async () => {
  const d = await qa.sammle(biz.id, Q);
  assert.equal(d.nutzung.total, 3);
  assert.equal(d.nutzung.vorquartal, 1);
  assert.equal(d.nutzung.kontingentMonat, 400);
  assert.equal(d.nutzung.kontingentQuartal, 1200);
  assert.equal(d.nutzung.auslastungProzent, 0);
  assert.equal(d.nutzung.proArt[0].name, 'LinkedIn-Beitrag');
  assert.equal(d.lern.gesamt, 2); assert.equal(d.lern.neu, 1); assert.equal(d.lern.gefestigt, 1);
  assert.equal(d.highlights.positiv, 1); assert.equal(d.highlights.negativ, 1);
  assert.equal(d.highlights.staerkste.length, 1);
  const ein = JSON.stringify(qa.kiEingabe(d));
  assert.ok(!/Business AG|GEHEIMER|Floskeln|Muster/.test(ein), 'keine Namen, Textinhalte oder Regelwortlaut');
});

test('Lauf: Mails an Lorena (mit Word) und Admin, Status versendet, Idempotenz je Quartal', async () => {
  H.brevoMails.length = 0; H.ai.calls.length = 0;
  const r = await qa.runForClient(biz.id, { now: NOW });
  assert.equal(r.status, 'fertig');
  assert.equal(r.quartal, Q);
  assert.equal(H.ai.calls.length, 1);
  assert.equal(H.ai.calls[0].meter.module, 'quartalsreview');
  assert.equal(H.ai.calls[0].meter.clientId, biz.id);
  assert.ok(!/GEHEIMER|Business AG/.test(JSON.stringify(H.ai.calls[0].messages)));
  const toL = H.brevoMails.filter(m => m.to === 'contact@lorenalienhard.ch');
  const toK = H.brevoMails.filter(m => m.to === 'k@test.ch');
  assert.equal(toL.length, 1); assert.equal(toK.length, 1);
  assert.ok(toL[0].attachments[0].name.endsWith('.docx') && toL[0].attachments[0].contentBase64.length > 1000);
  assert.ok(/Guten Tag Frau Muster/.test(toK[0].text) && /Ihre|Sie/.test(toK[0].text));
  assert.ok(!/[–—]/.test(toK[0].text + toL[0].text) && !/ß/.test(toK[0].text), 'Schweizer Schreibweise, keine Gedankenstriche');
  const rev = (await pool.query('SELECT status, versendet_am FROM quartalsreviews WHERE client_id=$1 AND quartal=$2', [biz.id, Q])).rows[0];
  assert.equal(rev.status, 'versendet'); assert.ok(rev.versendet_am);
  // zweiter Lauf: nichts passiert
  const again = await qa.runForClient(biz.id, { now: NOW });
  assert.equal(again.status, 'uebersprungen');
  assert.equal(H.ai.calls.length, 1); assert.equal(H.brevoMails.length, 2);
  // Notizfeld bleibt bedienbar
  const put = await srv.call('PUT', `/api/quartalsreview/${biz.id}/${Q}`, { token: H.advisorToken(), body: { termin: '12.11.2026', notizen: 'Gespräch vorbereitet', status: 'geplant' } });
  assert.equal(put.status, 200); assert.equal(put.body.status, 'geplant');
  assert.equal((await srv.call('PUT', `/api/quartalsreview/${biz.id}/${Q}`, { token: H.advisorToken(), body: { status: 'versendet' } })).status, 200);
});

test('Word: Abruf in der Plattform enthält die Abschnitte, KI-Text ohne Gedankenstrich', async () => {
  const r = await srv.call('GET', `/api/quartalsreview/${biz.id}/auswertung.docx?quartal=${Q}`, { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  const JSZip = require('jszip');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  for (const t of ['Quartalsauswertung', 'Nutzung des Quartals', 'Lernstand', 'Highlights', 'Empfehlungen für das Gespräch', 'LinkedIn-Beitrag', 'Kontingent besprechen']) assert.ok(xml.includes(t), t);
  assert.ok(!/[–—]/.test(xml.replace(/<[^>]+>/g, '')), 'keine Gedankenstriche im Dokument');
  assert.equal((await srv.call('GET', `/api/quartalsreview/${biz.id}/auswertung.docx?quartal=${Q}`, { token: H.clientToken(biz.id) })).status, 403);
  const st = await srv.call('GET', `/api/quartalsreview/${biz.id}/auswertung?quartal=${Q}`, { token: H.advisorToken() });
  assert.equal(st.body.lauf.status, 'fertig');
});

test('Job: alle Berechtigten, bereits ausgewertete werden ausgelassen', async () => {
  H.brevoMails.length = 0; H.ai.calls.length = 0;
  const out = await runQuartalsauswertungJob({ now: NOW });
  assert.equal(out.length, 3);
  assert.equal(out.find(o => o.clientId === biz.id).status, 'uebersprungen');
  assert.equal(out.find(o => o.clientId === ent.id).status, 'fertig');
  assert.equal(out.find(o => o.clientId === teamAddon.id).status, 'fertig');
  assert.equal(H.ai.calls.length, 2);
  assert.equal(H.brevoMails.length, 4);
  const again = await runQuartalsauswertungJob({ now: NOW });
  assert.ok(again.every(o => o.status === 'uebersprungen'));
  assert.equal(H.ai.calls.length, 2); assert.equal(H.brevoMails.length, 4);
});

test('Mail an den Klienten schlägt fehl: Wiederholung sendet nur die fehlende Mail, ohne neuen KI-Aufruf', async () => {
  await pool.query('DELETE FROM quartalsreview_laeufe WHERE client_id=$1', [ent.id]);
  H.brevoMails.length = 0; H.ai.calls.length = 0;
  await pool.query(`UPDATE clients SET email=NULL WHERE id=$1`, [ent.id]);
  const r1 = await qa.runForClient(ent.id, { now: NOW });
  assert.equal(r1.status, 'mailfehler');
  assert.equal(H.brevoMails.filter(m => m.to === 'contact@lorenalienhard.ch').length, 1);
  await pool.query(`UPDATE clients SET email='k@test.ch' WHERE id=$1`, [ent.id]);
  const r2 = await qa.runForClient(ent.id, { now: NOW });
  assert.equal(r2.status, 'fertig');
  assert.equal(H.ai.calls.length, 1, 'KI nur einmal');
  assert.equal(H.brevoMails.filter(m => m.to === 'contact@lorenalienhard.ch').length, 1, 'Lorena nicht doppelt');
  assert.equal(H.brevoMails.filter(m => m.to === 'k@test.ch').length, 1);
});

test('Kostenobergrenze: Lauf bricht sauber ab, kein Versand, später wiederholbar', async () => {
  await pool.query('DELETE FROM quartalsreview_laeufe WHERE client_id=$1', [teamAddon.id]);
  H.brevoMails.length = 0; H.ai.calls.length = 0;
  const r = await qa.runForClient(teamAddon.id, { now: NOW, capUsd: 0.000001 });
  assert.equal(r.status, 'abgebrochen');
  assert.equal(H.ai.calls.length, 0); assert.equal(H.brevoMails.length, 0);
  const r2 = await qa.runForClient(teamAddon.id, { now: NOW });
  assert.equal(r2.status, 'fertig');
});

test('Tagesbudget erreicht: der Job endet sauber und lässt die übrigen Klienten offen', async () => {
  await pool.query('DELETE FROM quartalsreview_laeufe');
  await pool.query(`INSERT INTO usage_log (module, model, input_tokens, cost_usd) VALUES ('quartalsreview','claude-haiku-4-5',1,5)`);
  H.brevoMails.length = 0; H.ai.calls.length = 0;
  const out = await runQuartalsauswertungJob({ now: NOW });
  assert.ok(out.length === 3 && out.every(o => o.status === 'uebersprungen'));
  assert.equal(H.ai.calls.length, 0);
  await pool.query('DELETE FROM usage_log');
});

test('Testlauf per Knopf: nur für die eigenen Klienten, ohne Versand möglich', async () => {
  await pool.query('DELETE FROM quartalsreview_laeufe');
  H.brevoMails.length = 0;
  assert.equal((await srv.call('POST', '/api/quartalsreview/auswertung/lauf', { token: H.clientToken(biz.id), body: {} })).status, 403);
  assert.equal((await srv.call('POST', '/api/quartalsreview/auswertung/lauf', { token: H.advisorToken(), body: { quartal: '2026-Q9' } })).status, 400);
  const r = await srv.call('POST', '/api/quartalsreview/auswertung/lauf', { token: H.advisorToken(), body: { clientId: biz.id, quartal: Q, mails: false } });
  assert.equal(r.status, 200); assert.equal(r.body[0].status, 'vorschau');
  assert.equal(H.brevoMails.length, 0);
  const w = await srv.call('GET', `/api/quartalsreview/${biz.id}/auswertung.docx?quartal=${Q}`, { token: H.advisorToken(), raw: true });
  assert.equal(w.status, 200);
  // Danach lässt sich dieselbe Auswertung versenden, ohne erneuten KI-Aufruf
  const n = H.ai.calls.length;
  const s2 = await srv.call('POST', '/api/quartalsreview/auswertung/lauf', { token: H.advisorToken(), body: { clientId: biz.id, quartal: Q } });
  assert.equal(s2.body[0].status, 'fertig');
  assert.equal(H.ai.calls.length, n);
  assert.equal(H.brevoMails.length, 2);
});

test('Webhook: Zusatzzahlung setzt das Flag, Paket und Kontingent bleiben', async () => {
  await pool.query(`UPDATE clients SET subscription_status='active' WHERE id=$1`, [team.id]);
  const mk = (type, extra) => ({ id: 'evt_q' + (++evn), type, data: { object: { customer: 'cus_q', currency: 'chf', ...extra } } });
  assert.equal((await flag(team.id)).f, false);
  const res = await post(mk('checkout.session.completed', { metadata: { clientId: String(team.id), type: 'quartalsreview' }, amount_total: 29000 }));
  assert.equal(res.status, 200);
  const f = await flag(team.id);
  assert.equal(f.f, true);
  assert.equal(Number(f.l), 750000, 'Kontingent unverändert (29000 wäre sonst das frühere Starter-Abo)');
  assert.equal(f.s, 'active');
  // Verlängerung nach drei Monaten über die Rechnung (Typ im Abo)
  await pool.query('UPDATE clients SET quartalsreview_aktiv=FALSE WHERE id=$1', [team.id]);
  await post(mk('invoice.paid', { subscription_details: { metadata: { clientId: String(team.id), type: 'quartalsreview' } }, amount_paid: 29000 }));
  assert.equal((await flag(team.id)).f, true);
  assert.equal(Number((await flag(team.id)).l), 750000);
});

test('Webhook: Zahlungsausfall und Kündigung nehmen das Flag zurück, Paket bleibt aktiv', async () => {
  const mk = (type, extra) => ({ id: 'evt_q' + (++evn), type, data: { object: { customer: 'cus_q', ...extra } } });
  const meta = { clientId: String(team.id), type: 'quartalsreview' };
  await post(mk('invoice.payment_failed', { subscription_details: { metadata: meta } }));
  assert.equal((await flag(team.id)).f, false, 'Zahlungsausfall');
  await post(mk('invoice.paid', { subscription_details: { metadata: meta } }));
  assert.equal((await flag(team.id)).f, true, 'erneute Zahlung');
  await post(mk('customer.subscription.updated', { status: 'past_due', metadata: meta }));
  assert.equal((await flag(team.id)).f, false, 'überfällig');
  await post(mk('invoice.paid', { subscription_details: { metadata: meta } }));
  await post(mk('customer.subscription.deleted', { metadata: meta }));
  const f = await flag(team.id);
  assert.equal(f.f, false, 'Kündigung');
  assert.equal(f.s, 'active', 'Kündigung des Zusatzes kündigt nicht das Paket');
  // Kündigung des Hauptabos ohne Typ lässt das Flag unberührt
  await pool.query('UPDATE clients SET quartalsreview_aktiv=TRUE WHERE id=$1', [team.id]);
  await post(mk('customer.subscription.deleted', { metadata: { clientId: String(team.id) } }));
  const g = await flag(team.id);
  assert.equal(g.s, 'cancelled'); assert.equal(g.f, true);
  await pool.query(`UPDATE clients SET subscription_status='active', quartalsreview_aktiv=FALSE WHERE id=$1`, [team.id]);
});

test('Kaufroute: nur Rolle admin, nur Stimme und Team, Abo mit Intervall 3 Monate', async () => {
  links.length = 0;
  const url = id => `/api/subscriptions/quartalsreview-link/${id}`;
  // Stimme und Team: erlaubt (Hauptzugang zählt als admin)
  const ok = await subsSrv.call('POST', url(team.id), { token: H.clientToken(team.id) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.url, 'https://pay.test/qr');
  const li = links[0];
  assert.equal(li.line_items[0].price_data.unit_amount, 29000);
  assert.equal(li.line_items[0].price_data.currency, 'chf');
  assert.deepEqual(li.line_items[0].price_data.recurring, { interval: 'month', interval_count: 3 });
  assert.equal(li.metadata.type, 'quartalsreview');
  assert.equal(li.subscription_data.metadata.type, 'quartalsreview');
  assert.equal(li.subscription_data.metadata.clientId, String(team.id));
  assert.equal((await subsSrv.call('POST', url(stimme.id), { token: H.clientToken(stimme.id) })).status, 200);
  // Rollen: Redakteur und Betrachter nicht
  const uid = async () => (await pool.query('INSERT INTO client_users (client_id) VALUES ($1) RETURNING id', [team.id])).rows[0].id;
  assert.equal((await subsSrv.call('POST', url(team.id), { token: H.clientToken(team.id, { clientUserId: await uid(), clientUserRole: 'editor' }) })).status, 403);
  assert.equal((await subsSrv.call('POST', url(team.id), { token: H.clientToken(team.id, { clientUserId: await uid(), clientUserRole: 'viewer' }) })).status, 403);
  assert.equal((await subsSrv.call('POST', url(team.id), { token: H.clientToken(team.id, { clientUserId: await uid(), clientUserRole: 'admin' }) })).status, 200);
  // Business und Enterprise: Zusatz nicht verfügbar
  assert.equal((await subsSrv.call('POST', url(biz.id), { token: H.clientToken(biz.id) })).status, 400);
  assert.equal((await subsSrv.call('POST', url(ent.id), { token: H.clientToken(ent.id) })).status, 400);
  // fremder Klient und ohne Anmeldung
  assert.equal((await subsSrv.call('POST', url(stimme.id), { token: H.clientToken(team.id) })).status, 403);
  assert.equal((await subsSrv.call('POST', url(team.id))).status, 401);
  // schon gebucht
  assert.equal((await subsSrv.call('POST', url(teamAddon.id), { token: H.clientToken(teamAddon.id) })).status, 400);
  // Beraterin hat dafür den Zahlungslink (create-payment-link), die Kaufroute ist Kundensache
  assert.equal((await subsSrv.call('POST', url(team.id), { token: H.advisorToken() })).status, 403);
  // Angebot zeigt sich in «Abo verwalten» nur dort, wo es gilt
  const o1 = await subsSrv.call('GET', `/api/subscriptions/abo/${team.id}`, { token: H.clientToken(team.id) });
  assert.deepEqual([o1.body.quartalsreview.verfuegbar, o1.body.quartalsreview.aktiv, o1.body.quartalsreview.amountCents, o1.body.quartalsreview.intervalMonths], [true, false, 29000, 3]);
  const o2 = await subsSrv.call('GET', `/api/subscriptions/abo/${biz.id}`, { token: H.clientToken(biz.id) });
  assert.equal(o2.body.quartalsreview.verfuegbar, false); assert.equal(o2.body.quartalsreview.imPaket, true);
  const o3 = await subsSrv.call('GET', `/api/subscriptions/abo/${teamAddon.id}`, { token: H.clientToken(teamAddon.id) });
  assert.equal(o3.body.quartalsreview.aktiv, true);
});

test('Beraterin-Zahlungslink für den Zusatz trägt dieselben Metadaten', async () => {
  links.length = 0;
  const r = await subsSrv.call('POST', `/api/subscriptions/create-payment-link/${team.id}`, { token: H.advisorToken(), body: { angebot: 'quartalsreview' } });
  assert.equal(r.status, 200);
  assert.equal(links[0].metadata.type, 'quartalsreview');
  assert.equal(links[0].subscription_data.metadata.type, 'quartalsreview');
  assert.equal(links[0].line_items[0].price_data.recurring.interval_count, 3);
});
