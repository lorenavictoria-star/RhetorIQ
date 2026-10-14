// Geschenk-PDFs: richtiges PDF pro Auswahl, Einwilligung, Rate-Limits, Mail mit Anhang (gemockt), PDFs nicht öffentlich, Lead in inquiries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const H = require('../test-support/harness');
const { pool } = H;
const B = require('../lib/buchung');
const G = require('../lib/geschenk');

const ORIGIN = 'https://rhetoriq.ch';
let srv, srvIp, srvEmail;

test.before(async () => {
  process.env.ADVISOR_EMAIL = 'contact@lorenalienhard.ch';
  delete process.env.ADVISOR_NOTIFY_EMAIL_2;
  await H.setupBase();
  const route = require('../routes/geschenk');
  await require('../routes/inquiries').ensureTable();
  srv = await H.startApp([['/api/geschenk', route.build({ ipMax: 1000, emailMax: 1000, ticketMax: 100000 })]]);
  srvIp = await H.startApp([['/api/geschenk', route.build({ ipMax: 3, emailMax: 1000 })]]);
  srvEmail = await H.startApp([['/api/geschenk', route.build({ ipMax: 1000, emailMax: 2 })]]);
});
test.after(async () => { await srv.close(); await srvIp.close(); await srvEmail.close(); });
test.beforeEach(async () => { await pool.query('DELETE FROM inquiries'); H.mails.length = 0; });

const wait = () => new Promise(r => setTimeout(r, 40));
const kinds = (k) => H.mails.filter(m => m.kind === k);
async function post(s, body, { origin = ORIGIN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const r = await fetch(s.base + '/api/geschenk', { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const geschenk = (felder = {}, s = srv) => post(s, { geschenk: 'prompt', name: 'Beat Beispiel', email: 'beat@firma.ch', einwilligung: true, ticket: B.ticketNeu(new Date(Date.now() - 10000)), ...felder });
const pdf = (datei) => fs.readFileSync(path.join(__dirname, '..', 'assets', 'geschenke', datei));

test('Stimm-Prompt: richtiges PDF im Anhang, Mail an die Person und Hinweis an Lorena', async () => {
  const r = await geschenk({ geschenk: 'prompt' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  await wait();
  const m = kinds('geschenk_pdf');
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'beat@firma.ch');
  assert.equal(m[0].senderName, 'Lorena Lienhard');
  assert.equal(m[0].attachments.length, 1);
  assert.equal(m[0].attachments[0].name, 'RhetorIQ_Stimm_Prompt.pdf');
  const buf = Buffer.from(m[0].attachments[0].contentBase64, 'base64');
  assert.ok(buf.equals(pdf('RhetorIQ_Stimm_Prompt.pdf')));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length < 1024 * 1024, 'Anhang klein');
  assert.ok(m[0].text.startsWith('Guten Tag Beat Beispiel'));
  assert.ok(m[0].text.includes('Stimm-Schnelltest') && m[0].text.includes('https://rhetoriq.ch/termin') && m[0].text.includes('zwanzig Minuten'));
  assert.ok(m[0].subject.includes('Stimm-Prompt'));
  const h = kinds('geschenk_hinweis');
  assert.equal(h.length, 1);
  assert.equal(h[0].to, 'contact@lorenalienhard.ch');
  assert.ok(h[0].text.includes('Beat Beispiel') && h[0].text.includes('beat@firma.ch') && h[0].text.includes('Stimm-Prompt'));
  assert.ok(!h[0].attachments);
  for (const x of H.mails) assert.ok(!/[–—―ß]/.test(x.subject + x.text), 'Schreibregeln: ' + x.kind);
});

test('KI-Leitfaden: das andere PDF', async () => {
  const r = await geschenk({ geschenk: 'leitfaden', email: 'cora@firma.ch' });
  assert.equal(r.status, 200);
  await wait();
  const m = kinds('geschenk_pdf')[0];
  assert.equal(m.attachments[0].name, 'RhetorIQ_KI_Leitfaden.pdf');
  assert.ok(Buffer.from(m.attachments[0].contentBase64, 'base64').equals(pdf('RhetorIQ_KI_Leitfaden.pdf')));
  assert.ok(m.subject.includes('KI-Leitfaden'));
});

test('Unbekannte Auswahl wird abgelehnt (auch Pfadtricks)', async () => {
  for (const g of ['', 'alle', '../server/index.js', '__proto__', 'constructor', 'toString', 5, null]) {
    const r = await geschenk({ geschenk: g });
    assert.equal(r.status, 400, String(g));
    assert.equal(r.body.feld, 'geschenk');
  }
  await wait();
  assert.equal(H.mails.length, 0);
});

test('Lead landet in inquiries mit source geschenk-prompt oder geschenk-leitfaden', async () => {
  await geschenk({ geschenk: 'prompt', email: 'a@firma.ch', name: 'Anna A' });
  await geschenk({ geschenk: 'leitfaden', email: 'b@firma.ch', name: 'Bruno B' });
  const rows = (await pool.query('SELECT name, email, source, status, message, ack_sent_at FROM inquiries ORDER BY id')).rows;
  assert.deepEqual(rows.map(r => r.source), ['geschenk-prompt', 'geschenk-leitfaden']);
  assert.deepEqual(rows.map(r => r.status), ['neu', 'neu'], 'erscheint in den Anfragen und im Tagesplan');
  assert.ok(rows[0].message.includes('Stimm-Prompt') && rows[1].message.includes('KI-Leitfaden'));
  assert.ok(rows.every(r => r.ack_sent_at), 'keine zweite Eingangsbestätigung');
  // die Anfragenliste der Beraterin liefert sie
  const inq = require('../routes/inquiries');
  const s = await H.startApp([['/api/inquiries', inq.advisorRouter]]);
  try {
    const l = await s.call('GET', '/api/inquiries', { token: H.advisorToken() });
    assert.equal(l.status, 200);
    assert.equal(l.body.length, 2);
  } finally { await s.close(); }
});

test('Einwilligung ist Pflicht, ebenso Name und E-Mail', async () => {
  for (const [felder, feld] of [[{ einwilligung: false }, 'einwilligung'], [{ einwilligung: undefined }, 'einwilligung'], [{ einwilligung: 'ja' }, 'einwilligung'], [{ name: '' }, 'name'],
    [{ name: 'www.spam.example' }, 'name'], [{ email: 'kaputt' }, 'email'], [{ email: '' }, 'email'], [{ email: 'a@b.ch\nBcc: x@y.ch' }, 'email']]) {
    const r = await geschenk(felder);
    assert.equal(r.status, 400, JSON.stringify(felder));
    assert.equal(r.body.feld, feld);
  }
  await wait();
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM inquiries')).rows[0].n, 0);
  assert.equal(H.mails.length, 0);
});

test('Missbrauchsschutz: Herkunft, Honeypot, Ticket, Mindestzeit', async () => {
  const basis = { geschenk: 'prompt', name: 'Beat Beispiel', email: 'beat@firma.ch', einwilligung: true, ticket: B.ticketNeu(new Date(Date.now() - 10000)) };
  assert.equal((await post(srv, basis, { origin: 'https://boese.example' })).status, 401);
  assert.equal((await post(srv, basis, { origin: null })).status, 401);
  const bot = await geschenk({ website2: 'x' });
  assert.equal(bot.status, 200);
  assert.equal((await geschenk({ ticket: undefined })).status, 400);
  assert.equal((await geschenk({ ticket: 'a.b' })).status, 400);
  assert.equal((await geschenk({ ticket: B.ticketNeu(new Date(Date.now() - 7 * 3600000)) })).status, 400);
  assert.equal((await geschenk({ ticket: B.ticketNeu(new Date()) })).status, 429);
  await wait();
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM inquiries')).rows[0].n, 0);
  assert.equal(H.mails.length, 0);
});

test('Ticket-Abruf liefert ein gültiges Ticket', async () => {
  const j = await (await fetch(srv.base + '/api/geschenk/ticket')).json();
  assert.ok(B.ticketAlter(j.ticket, new Date()) >= 0);
});

test('Rate-Limit pro IP, pro E-Mail und Tageslimit', async () => {
  const s1 = [];
  for (let i = 0; i < 4; i++) s1.push((await geschenk({ email: `ip${i}@firma.ch` }, srvIp)).status);
  assert.deepEqual(s1, [200, 200, 200, 429]);
  const s2 = [];
  for (let i = 0; i < 3; i++) s2.push((await geschenk({ email: 'gleich@firma.ch', geschenk: i % 2 ? 'prompt' : 'leitfaden' }, srvEmail)).status);
  assert.deepEqual(s2, [200, 200, 429]);
  await pool.query('DELETE FROM inquiries');
  for (let i = 0; i < 120; i++) await pool.query(`INSERT INTO inquiries (name, email, message, source) VALUES ('P','p${i}@x.ch','m','geschenk-prompt')`);
  const r = await geschenk({ email: 'zuviel@firma.ch' });
  assert.equal(r.status, 429);
  assert.ok(/morgen/.test(r.body.error));
});

test('Dasselbe Geschenk an dieselbe Adresse höchstens einmal je 24 Stunden', async () => {
  await geschenk({ email: 'dop@firma.ch' });
  await wait();
  const r = await geschenk({ email: 'DOP@firma.ch' });
  assert.equal(r.status, 200); assert.equal(r.body.schon, true);
  await wait();
  assert.equal(kinds('geschenk_pdf').length, 1);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM inquiries WHERE email='dop@firma.ch'`)).rows[0].n, 1);
  // das andere Geschenk geht an dieselbe Adresse
  const r2 = await geschenk({ email: 'dop@firma.ch', geschenk: 'leitfaden' });
  assert.equal(r2.body.schon, false);
  await wait();
  assert.equal(kinds('geschenk_pdf').length, 2);
});

test('Die PDFs sind nicht öffentlich erreichbar', async () => {
  const server = path.join(__dirname, '..');
  const pub = path.join(server, '..', 'public');
  assert.ok(!fs.existsSync(path.join(pub, 'assets')), 'kein assets-Ordner in public');
  const rec = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? rec(path.join(d, e.name)) : [e.name]);
  assert.ok(!rec(pub).some(n => /\.pdf$/i.test(n) && /Stimm_Prompt|KI_Leitfaden/.test(n)), 'keine Geschenk-PDFs in public');
  // Server liefert statisch nur den Ordner public aus
  const src = fs.readFileSync(path.join(server, 'index.js'), 'utf8');
  const statics = [...src.matchAll(/express\.static\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(statics.length > 0 && statics.every(a => /FRONTEND/.test(a) && !/assets|geschenk/i.test(a)), statics.join(' | '));
  // praktische Probe: ein Server mit static(public) und dem Router findet die Dateien unter keiner Adresse
  const app = express();
  app.use('/api/geschenk', require('../routes/geschenk').build({}));
  app.use(express.static(pub, { index: false }));
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const u of ['/assets/geschenke/RhetorIQ_Stimm_Prompt.pdf', '/RhetorIQ_Stimm_Prompt.pdf', '/RhetorIQ_KI_Leitfaden.pdf', '/server/assets/geschenke/RhetorIQ_KI_Leitfaden.pdf',
      '/api/geschenk/RhetorIQ_Stimm_Prompt.pdf', '/api/geschenk/prompt', '/api/geschenk/leitfaden', '/api/geschenk/../../assets/geschenke/RhetorIQ_Stimm_Prompt.pdf']) {
      const r = await fetch(base + u);
      assert.equal(r.status, 404, u);
      assert.notEqual(r.headers.get('content-type'), 'application/pdf', u);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('Die Geschenk-Dateien sind klein und gültige PDFs', () => {
  for (const g of Object.values(G.GESCHENKE)) {
    const b = pdf(g.datei);
    assert.equal(b.subarray(0, 5).toString(), '%PDF-', g.datei);
    assert.ok(b.length < G.MAX_BYTES && b.length < 200 * 1024, g.datei + ' ' + b.length);
  }
});
