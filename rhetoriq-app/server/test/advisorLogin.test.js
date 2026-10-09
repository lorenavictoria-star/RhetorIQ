// F-13: Sperre pro Konto, Passwortlänge, Passwortwechsel der Beraterin beendet alte Sitzungen, Alle Geräte abmelden.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const H = require('../test-support/harness');
const { pool } = H;

let srv;
test.before(async () => {
  await H.setupBase();
  for (const col of ['email TEXT', 'name TEXT', 'password_hash TEXT', 'role TEXT']) await pool.query(`ALTER TABLE client_users ADD COLUMN ${col}`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_email_uq UNIQUE (email)`).catch(() => {});
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=1`, [await bcrypt.hash('lorenas-langes-passwort', 4)]);
  await pool.query(`UPDATE users SET email='lorena@test.ch' WHERE id=1`);
  srv = await H.startApp([['/auth', require('../routes/auth')]]);
});
test.after(async () => { await srv.close(); });

const login = (pw, email = 'lorena@test.ch') => srv.call('POST', '/auth/login', { body: { email, password: pw } });

test('F-13 Normalfall: Beraterin meldet sich an, ein Fehlversuch ändert nichts', async () => {
  assert.equal((await login('falsch')).status, 401);
  const ok = await login('lorenas-langes-passwort');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test('F-13 Sperre: 10 Fehlversuche, dann Pause für dieses Konto; andere Konten nicht betroffen', async () => {
  require('../lib/loginLock').reset();
  for (let i = 0; i < 10; i++) assert.equal((await login('falsch' + i)).status, 401);
  const gesperrt = await login('lorenas-langes-passwort');
  assert.equal(gesperrt.status, 429, 'auch das richtige Passwort wird während der Pause nicht angenommen');
  assert.match(gesperrt.body.error, /Fehlversuche/);
  // anderes Konto bleibt frei
  assert.equal((await login('x', 'andere@test.ch')).status, 401);
  require('../lib/loginLock').reset();
  assert.equal((await login('lorenas-langes-passwort')).status, 200);
});

test('F-13 Passwort: neue Passwörter mindestens 12 Zeichen (Registrierung, Klient)', async () => {
  const { validPassword } = require('../lib/passwordPolicy');
  assert.equal(validPassword('kurz1234'), false);
  assert.equal(validPassword('ein-langer-satz'), true);
  await pool.query(`CREATE TABLE invite_codes (id SERIAL PRIMARY KEY, code TEXT, created_by INTEGER, used_by INTEGER, used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'))`).catch(() => {});
  await pool.query(`INSERT INTO invite_codes (code) VALUES ('ABCD1234')`);
  const kurz = await srv.call('POST', '/auth/register', { body: { email: 'neu@test.ch', password: 'kurz1234', name: 'N', inviteCode: 'ABCD1234' } });
  assert.equal(kurz.status, 400);
  assert.match(kurz.body.error, /12 Zeichen/);
});

test('F-13 Alle Geräte abmelden und Passwortwechsel in Render beenden alte Sitzungen der Beraterin', async () => {
  const probe = require('express').Router();
  probe.get('/', require('../middleware/auth').requireAuth, (req, res) => res.json({ ok: true }));
  const s2 = await H.startApp([['/auth', require('../routes/auth')], ['/probe', probe]]);
  try {
    require('../lib/loginLock').reset();
    const t = (await s2.call('POST', '/auth/login', { body: { email: 'lorena@test.ch', password: 'lorenas-langes-passwort' } })).body.token;
    assert.equal((await s2.call('GET', '/probe', { token: t })).status, 200);
    assert.equal((await s2.call('POST', '/auth/logout-all', { token: t })).status, 200);
    assert.equal((await s2.call('GET', '/probe', { token: t })).status, 401);
    // Passwortwechsel über die Umgebungsvariable (Start): token_version steigt nur bei geändertem Passwort
    const { seedAdvisor } = require('../lib/seedAdvisor');
    const t2 = (await s2.call('POST', '/auth/login', { body: { email: 'lorena@test.ch', password: 'lorenas-langes-passwort' } })).body.token;
    const same = await seedAdvisor({ ADVISOR_EMAIL: 'lorena@test.ch', ADVISOR_PASSWORD: 'lorenas-langes-passwort', ADVISOR_NAME: 'Lorena' });
    assert.equal(same.changed, false);
    assert.equal((await s2.call('GET', '/probe', { token: t2 })).status, 200, 'gleiches Passwort: Sitzung bleibt');
    const changed = await seedAdvisor({ ADVISOR_EMAIL: 'lorena@test.ch', ADVISOR_PASSWORD: 'ein-ganz-neues-passwort', ADVISOR_NAME: 'Lorena' });
    assert.equal(changed.changed, true);
    assert.equal((await s2.call('GET', '/probe', { token: t2 })).status, 401, 'neues Passwort: alte Sitzung beendet');
    require('../lib/loginLock').reset();
    assert.equal((await s2.call('POST', '/auth/login', { body: { email: 'lorena@test.ch', password: 'ein-ganz-neues-passwort' } })).status, 200);
  } finally { await s2.close(); }
});
