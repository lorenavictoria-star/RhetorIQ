// Goldtexte: Speicherung, Auswahl, Trennung der Klienten, Begrenzung.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');
const { saveGoldFromReview, getGoldBlock, BLOCK_LIMIT } = require('../lib/goldtexte');

test.before(async () => { await H.setupBase(); });

const satz = (n, w) => Array.from({ length: n }, (_, i) => `${w} Satz Nummer ${i + 1} erklärt etwas Eigenes zum Thema.`).join(' ');

async function review(clientId, { original, edited, status = 'approved', tile = 'email' }) {
  const { rows } = await H.pool.query(
    `INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status, module_key, module_tile)
     VALUES ($1,'E-Mail',$2,$3,$4,'text-gen',$5) RETURNING id`, [clientId, original, edited, status, tile]);
  return rows[0].id;
}

test('Goldtexte: gespeichert werden nur gesendete, genug veränderte Texte passender Länge, ohne Duplikate', async () => {
  const c = await H.addClient('Gold A AG');
  const orig = satz(6, 'Alt');
  const fin = satz(6, 'Neu');
  const ok = await saveGoldFromReview(await review(c.id, { original: orig, edited: fin }));
  assert.equal(ok.saved, true);
  // nicht gesendet
  assert.ok((await saveGoldFromReview(await review(c.id, { original: orig, edited: satz(6, 'Zwei'), status: 'edited' }))).skipped);
  // zu kurz
  assert.ok((await saveGoldFromReview(await review(c.id, { original: 'Kurz alt.', edited: 'Kurz neu.' }))).skipped);
  // zu lang
  assert.ok((await saveGoldFromReview(await review(c.id, { original: orig, edited: satz(200, 'Lang') }))).skipped);
  // kaum verändert (unter 10 Prozent)
  const gross = Array.from({ length: 20 }, (_, i) => `Satz Nummer ${i} bleibt wie er ist und sagt etwas.`).join(' ');
  assert.equal((await saveGoldFromReview(await review(c.id, { original: gross, edited: gross.replace('Satz Nummer 3 bleibt', 'Satz Nummer 3 blieb') }))).skipped, 'kaum verändert');
  // Duplikat aus anderer Freigabe
  assert.equal((await saveGoldFromReview(await review(c.id, { original: orig, edited: fin }))).skipped, 'Duplikat');
  const { rows } = await H.pool.query('SELECT * FROM goldtexte WHERE client_id=$1', [c.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback_key, 'text-gen-email');
});

test('Goldtexte: höchstens 20 je Klient und Textart, die ältesten fallen weg', async () => {
  const c = await H.addClient('Gold B AG');
  for (let i = 0; i < 23; i++) await saveGoldFromReview(await review(c.id, { original: satz(6, 'Alt' + i), edited: satz(6, 'Fassung' + i) }));
  const { rows } = await H.pool.query('SELECT text FROM goldtexte WHERE client_id=$1', [c.id]);
  assert.equal(rows.length, 20);
  assert.ok(!rows.some(r => r.text.startsWith('Fassung0 ')), 'ältester ist weg');
  assert.ok(rows.some(r => r.text.startsWith('Fassung22 ')));
});

test('Goldtexte: Auswahl nimmt den jüngsten und einen ähnlichen, trennt Klienten und Textarten, begrenzt die Länge', async () => {
  const a = await H.addClient('Gold C AG');
  const b = await H.addClient('Gold D AG');
  const mk = (thema, wort) => `${thema} ${wort} `.repeat(1) + Array.from({ length: 6 }, (_, i) => `Absatz ${i} handelt ausführlich von ${thema} und vom Kunden ${wort}.`).join(' ');
  const t1 = mk('Preiserhöhung', 'Alpha');
  const t2 = mk('Messeeinladung', 'Beta');
  const t3 = mk('Lieferverzug', 'Gamma');
  const t4 = mk('Preiserhöhung', 'Delta');
  for (const t of [t1, t2, t3, t4]) await H.pool.query(`INSERT INTO goldtexte (client_id, feedback_key, text) VALUES ($1,'text-gen-email',$2)`, [a.id, t]);
  await H.pool.query(`INSERT INTO goldtexte (client_id, feedback_key, text) VALUES ($1,'text-gen-email','FREMDER KLIENT Text.'),($2,'text-gen-linkedin','ANDERE TEXTART Text.')`, [b.id, a.id]);
  const block = await getGoldBlock(a.id, ['text-gen', 'text-gen-email'], 'Bitte eine Mail zur Preiserhöhung ab April');
  assert.ok(block.includes('Vorbild: So hat die Beraterin einen früheren Text dieses Klienten finalisiert. Stil übernehmen, Inhalt nicht'));
  assert.ok(block.includes('VORBILD 1') && block.includes('VORBILD 2') && !block.includes('VORBILD 3'));
  assert.ok(block.includes('Delta'), 'der jüngste');
  assert.ok(block.includes('Alpha'), 'der inhaltlich ähnliche (Preiserhöhung)');
  assert.ok(!block.includes('FREMDER KLIENT') && !block.includes('ANDERE TEXTART'));
  assert.ok(block.length <= BLOCK_LIMIT);
  // sehr lange Texte werden gekürzt
  const c = await H.addClient('Gold E AG');
  const lang = Array.from({ length: 150 }, (_, i) => `Langer Satz ${i} mit Inhalt.`).join(' ');
  await H.pool.query(`INSERT INTO goldtexte (client_id, feedback_key, text) VALUES ($1,'rp',$2),($1,'rp',$2 || ' zwei')`, [c.id, lang]);
  const lb = await getGoldBlock(c.id, ['rp'], 'Satz');
  assert.ok(lb.length <= BLOCK_LIMIT && lb.includes('VORBILD 2'));
  // nichts gespeichert: leer
  assert.equal(await getGoldBlock((await H.addClient('Gold F AG')).id, ['text-gen-email'], 'x'), '');
  assert.equal(await getGoldBlock(null, ['text-gen-email'], 'x'), '');
});
