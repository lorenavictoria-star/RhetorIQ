const test = require('node:test');
const assert = require('node:assert');
const { fuerTextart, ohneGedankenstriche } = require('../lib/brandVoiceAuswahl');
const { stilmittelRegeln, erlaubtFuer } = require('../lib/lintErlaubt');

const BV = ['KERN', 'Portrait und Regeln.', 'Stilmittel erlaubt: Dreierketten (Webseite, LinkedIn); Gegenüberstellungen (Webseite)',
  'DETAIL (Textarten: Webseite, LinkedIn): Marketing', 'Marketing-Details.', 'DETAIL (Textarten: Mail): Korrespondenz', 'Mail-Details.', 'DETAIL: Allgemein', 'Immer dabei.'].join('\n');

test('Detailabschnitte erscheinen nur für passende Textarten, der Kern immer', () => {
  const web = fuerTextart(BV, 'website');
  assert.ok(web.includes('Portrait und Regeln.') && web.includes('Marketing-Details.') && web.includes('Immer dabei.'));
  assert.ok(!web.includes('Mail-Details.'));
  const mail = fuerTextart(BV, 'email');
  assert.ok(mail.includes('Mail-Details.') && !mail.includes('Marketing-Details.'));
});

test('Ohne Gliederung oder ohne Textart bleibt das Dokument vollständig', () => {
  assert.equal(fuerTextart('KERNIDENTITÄT: Text', 'email'), 'KERNIDENTITÄT: Text');
  assert.equal(fuerTextart(BV, null), BV);
});

test('Stilmittel gelten je Textart', () => {
  const r = stilmittelRegeln(BV);
  assert.ok(erlaubtFuer(r, 'website').has('dreierkette') && erlaubtFuer(r, 'website').has('gegenueberstellung'));
  assert.ok(erlaubtFuer(r, 'linkedin').has('dreierkette') && !erlaubtFuer(r, 'linkedin').has('gegenueberstellung'));
  assert.equal(erlaubtFuer(r, 'email').size, 0);
});

test('Gedankenstriche fliegen aus der Brand Voice vor dem Prompt', () => {
  assert.equal(ohneGedankenstriche('Wir liefern — pünktlich. A–B'), 'Wir liefern, pünktlich. A-B');
});
