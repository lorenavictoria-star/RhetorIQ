// Keine Doppelaufrufe für dieselbe Auswertung: Lernvorschläge je Freigabe, Webseiten-Scan mit gleicher Eingabe.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/harness');

test.before(async () => {
  await H.setupBase();
  await require('../lib/schemaRedesign').ensureSchema();
  await H.pool.query(`CREATE TABLE IF NOT EXISTS client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
  await H.pool.query(`CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, advisor_id INTEGER, client_id INTEGER, module TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, model TEXT, cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cost_usd NUMERIC(14,6), created_at TIMESTAMPTZ DEFAULT NOW())`);
});

test('Freigabe zweimal kurz hintereinander gesendet: höchstens ein KI-Aufruf für die Lernvorschläge', async () => {
  const { learnFromReview } = require('../lib/learnFromCorrections');
  const c = await H.addClient('Doppel AG');
  const orig = 'Wir erhöhen die Preise per 1. April um drei Prozent. Das ist leider unumgänglich geworden. Wir bedanken uns für Ihr Verständnis und verbleiben.';
  const fin = 'Ab dem 1. April steigen unsere Preise um drei Prozent. Damit sichern wir die Qualität. Herzlichen Dank für Ihr Vertrauen.';
  const { rows } = await H.pool.query(
    `INSERT INTO review_requests (client_id, module_label, original_text, edited_text, status, module_key, module_tile) VALUES ($1,'E-Mail',$2,$3,'approved','text-gen','email') RETURNING id`,
    [c.id, orig, fin]);
  H.ai.fail = false; H.ai.calls.length = 0;
  H.ai.reply = () => new Promise(r => setTimeout(() => r('[{"category":"TON","observation":"Persönlicher, warmer Schluss mit Dank statt Floskel.","before":"verbleiben","after":"Herzlichen Dank"}]'), 60));
  const [a, b] = await Promise.all([learnFromReview(rows[0].id), learnFromReview(rows[0].id)]);
  assert.equal(H.ai.calls.length, 1, 'ein Aufruf trotz zweier gleichzeitiger Auslöser');
  assert.ok([a, b].some(x => x && x.skipped === 'läuft bereits'));
  // Danach ist die Freigabe ausgewertet: ein weiteres Senden löst nichts mehr aus
  const c3 = await learnFromReview(rows[0].id);
  assert.equal(H.ai.calls.length, 1);
  assert.ok(c3.skipped);
  assert.equal(H.ai.calls[0].meter.module, 'lernen-korrektur');
  assert.match(H.ai.calls[0].model, /haiku/, 'Lernvorschläge laufen auf dem günstigen Modell');
});

test('Webseiten-Scan: gleiche Eingabe liefert das Ergebnis aus dem Speicher, geänderte Eingabe einen neuen Aufruf', async () => {
  const { scanWebsite } = require('../lib/websiteScan');
  H.ai.calls.length = 0;
  H.ai.reply = JSON.stringify({ blick: ['Klare Seite mit deutlicher Ansprache.'], kommunikation: ['Sachlich'], module: [] });
  const text = 'Wir sind ein Familienunternehmen mit Sitz in Bern und bauen seit 1950 Küchen für anspruchsvolle Kundschaft. '.repeat(3);
  const r1 = await scanWebsite({ text, firma: 'Küchen Muster AG', sektor: 'kmu' });
  const r2 = await scanWebsite({ text, firma: 'Küchen Muster AG', sektor: 'kmu' });
  assert.equal(H.ai.calls.length, 1, 'zweiter Scan aus dem Speicher');
  assert.deepEqual(r2, r1);
  r2.blick.push('Veränderung der Kopie');
  assert.equal((await scanWebsite({ text, firma: 'Küchen Muster AG', sektor: 'kmu' })).blick.length, r1.blick.length, 'die Kopie verändert den Speicher nicht');
  await scanWebsite({ text, firma: 'Küchen Muster AG', sektor: 'industrie' });
  assert.equal(H.ai.calls.length, 2, 'anderer Sektor, neuer Scan');
  assert.equal(H.ai.calls[0].meter.module, 'website-scan');
});
