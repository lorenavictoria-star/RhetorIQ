// SEO- und KI-Suche-Seitentypen der Textart Website bekommen eigene Schreibregeln.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROMPTS } = require('../routes/analyze')._internal;
const sys = (format) => PROMPTS['text-gen'].system({ format });

test('SEO-Seitentypen nutzen die SEO-Regeln, KI-Suche die KI-Suche-Regeln', () => {
  for (const f of ['SEO — Seite für Suchmaschinen', 'SEO — Standort- oder Restaurantseite (lokal)', 'SEO — Blogartikel', 'SEO — Titel und Beschreibung (Meta)']) {
    assert.ok(sys(f).includes('SEO-SPECIFIC RULES'), f);
    assert.ok(!sys(f).includes('KI-SUCHE-SPECIFIC'), f);
  }
  for (const f of ['KI-Suche — Antwortseite für KI-Modelle', 'KI-Suche — FAQ für KI-Modelle']) {
    assert.ok(sys(f).includes('KI-SUCHE-SPECIFIC RULES'), f);
    assert.ok(!sys(f).includes('SEO-SPECIFIC'), f);
  }
});

test('Bisherige Seitentypen behalten die Website-Regeln', () => {
  for (const f of ['Homepage Hero', 'Landing Page', 'FAQ']) {
    assert.ok(sys(f).includes('WEBSITE COPY-SPECIFIC RULES'), f);
    assert.ok(!sys(f).includes('SEO-SPECIFIC'), f);
  }
});

test('SEO- und KI-Suche-Regeln schützen vor erfundenen Fakten', () => {
  assert.ok(/Lücke in eckigen Klammern/.test(sys('SEO — Blogartikel')));
  assert.ok(/Lücke in eckigen Klammern/.test(sys('KI-Suche — Antwortseite für KI-Modelle')));
});

test('Textart Social Media: eigene Regeln je Plattform, Fakten nur aus dem Auftrag', () => {
  for (const f of ['Instagram-Post', 'Instagram — Reel-Skript', 'Instagram — Story-Folge', 'Facebook-Beitrag', 'TikTok-Skript']) {
    const s = sys(f);
    assert.ok(s.includes('SOCIAL-MEDIA-SPECIFIC RULES'), f);
    assert.ok(/Lücke in eckigen Klammern/.test(s), f);
    assert.ok(!s.includes('WEBSITE COPY-SPECIFIC'), f);
  }
});

test('Textart Social Media ist freischaltbar und in der Brand Voice als Textart erkannt', () => {
  assert.ok(require('../lib/moduleAccess').TEXTARTEN.includes('social'));
  const { fuerTextart } = require('../lib/brandVoiceAuswahl');
  const bv = 'KERN\nKern\nDETAIL (Textarten: Social Media, Webseite): Hashtags\nNur Social.\nDETAIL (Textarten: Brief): Brief\nNur Brief.';
  const social = fuerTextart(bv, 'social');
  assert.ok(social.includes('Nur Social.') && !social.includes('Nur Brief.'));
  assert.ok(!fuerTextart(bv, 'linkedin').includes('Nur Social.'));
});
