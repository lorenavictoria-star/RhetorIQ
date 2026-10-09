// Notfallkarte: Inhalt aus dem Bericht, nur Beraterin, Word, Stilregeln, keine Zugangsdaten.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const H = require('../test-support/harness');
const nd = require('../lib/notfalldokumente');

let srv;
test.before(async () => {
  await H.setupBase();
  srv = await H.startApp([['/api/notfallkarte', require('../routes/notfallkarte')]]);
});
test.after(async () => { await srv.close(); });

async function docText(buf) {
  const z = await JSZip.loadAsync(buf);
  return (await z.file('word/document.xml').async('string')).replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}

test('Karte hat sieben Symptome, sieben Schritte, drei Textbausteine und drei öffentliche Statusseiten', async () => {
  const r = await srv.call('GET', '/api/notfallkarte', { token: H.advisorToken() });
  assert.equal(r.status, 200);
  assert.equal(r.body.tabelle.length, 7);
  assert.equal(r.body.sechzig.length, 7);
  assert.equal(r.body.bausteine.length, 3);
  assert.deepEqual(r.body.links.map(l => l.url), ['https://status.anthropic.com', 'https://status.render.com', 'https://status.stripe.com']);
  assert.equal(r.body.hinweis, 'Diese Seite enthält keine Passwörter.');
});

test('Nur Beraterin', async () => {
  const c = await H.addClient('Kartenfirma');
  assert.equal((await srv.call('GET', '/api/notfallkarte')).status, 401);
  assert.equal((await srv.call('GET', '/api/notfallkarte', { token: H.clientToken(c.id) })).status, 403);
  const w = await srv.call('GET', '/api/notfallkarte/notfallkarte.docx', { token: H.clientToken(c.id) });
  assert.equal(w.status, 403);
});

test('Word: enthält Karte und Textbausteine', async () => {
  const r = await srv.call('GET', '/api/notfallkarte/notfallkarte.docx', { token: H.advisorToken(), raw: true });
  assert.equal(r.status, 200);
  const t = await docText(Buffer.from(await r.arrayBuffer()));
  for (const s of ['Notfallkarte', 'Plattform lädt nicht', 'Textbaustein 3, Entwarnung', 'status.stripe.com', 'Diese Seite enthält keine Passwörter']) assert.ok(t.includes(s), s);
});

test('Stilregeln: keine Gedankenstriche, kein ß, keine Zugangsdaten in Karte und Notfallordner', async () => {
  const ordner = await docText(await nd.buildNotfallordner());
  const karte = await docText(await nd.buildNotfallkarte());
  for (const t of [ordner, karte, JSON.stringify(nd.KARTE)]) {
    assert.ok(!/[–—]/.test(t), 'Gedankenstrich');
    assert.ok(!t.includes('ß'), 'ß');
    assert.ok(!/sk-ant|password\s*[:=]|passwort\s*[:=]/i.test(t), 'Zugangsdaten');
    assert.ok(!/nicht[^.]{0,40}, sondern/i.test(t), 'nicht ..., sondern');
  }
  for (const d of ['Render', 'GitHub', 'Stripe', 'Anthropic', 'Brevo', 'AssemblyAI', 'Sentry', 'Domain']) assert.ok(ordner.includes(d), d);
  assert.ok(ordner.includes('Abwesenheitsmeldung'));
});
