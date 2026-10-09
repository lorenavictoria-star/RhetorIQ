// F-19: KI-Fehler gehen an Sentry, zweite Benachrichtigungsadresse.
// Dieser Test lädt die echte lib/aiProvider.js (ohne die Testumgebung mit Attrappen).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key-nicht-echt';
const test = require('node:test');
const assert = require('node:assert/strict');

const captured = [];
const sentryPath = require.resolve('@sentry/node');
require.cache[sentryPath] = {
  id: sentryPath, filename: sentryPath, loaded: true, children: [], paths: [],
  exports: {
    withScope: (fn) => fn({ setTag() {} }),
    captureException: (e) => captured.push(e)
  }
};
const ai = require('../lib/aiProvider');

test('F-19 Fehlgeschlagener KI-Aufruf wird an Sentry gemeldet und weitergereicht', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Anfrage kaputt' } }) });
  try {
    await assert.rejects(() => ai.generateText({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, model: 'claude-test' }), /Anfrage kaputt/);
    assert.equal(captured.length, 1);
    assert.match(captured[0].message, /Anfrage kaputt/);
  } finally { global.fetch = realFetch; }
});

test('F-19 Zweite Benachrichtigungsadresse ist optional und ohne Doppelungen', () => {
  const { advisorEmails } = require('../lib/notify');
  delete process.env.ADVISOR_NOTIFY_EMAIL_2;
  process.env.ADVISOR_EMAIL = 'eins@test.ch';
  assert.deepEqual(advisorEmails(), ['eins@test.ch']);
  process.env.ADVISOR_NOTIFY_EMAIL_2 = 'zwei@test.ch';
  assert.deepEqual(advisorEmails(), ['eins@test.ch', 'zwei@test.ch']);
  process.env.ADVISOR_NOTIFY_EMAIL_2 = 'eins@test.ch';
  assert.deepEqual(advisorEmails(), ['eins@test.ch']);
});
