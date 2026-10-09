// scripts/backup.sh mit Attrappen für pg_dump und pg_restore (keine echte Datenbank, keine Zugangsdaten).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup.sh');
const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const skip = !have('bash') || !have('openssl') ? 'bash oder openssl fehlt' : false;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-backup-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pg_dump'),
    '#!/usr/bin/env bash\nif [ -n "${SHIM_FAIL:-}" ]; then echo kaputt >&2; exit 1; fi\nif [ -n "${SHIM_TINY:-}" ]; then echo klein; exit 0; fi\nhead -c 4096 /dev/zero | tr "\\0" "x"\necho SHIM-DUMP-INHALT\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pg_restore'), '#!/usr/bin/env bash\nfor last; do :; done\ntail -c 17 "$last" > "$RESTORE_OUT"\n', { mode: 0o755 });
  return { dir, bin };
}
const run = (args, env, bin) => spawnSync('bash', [SCRIPT, ...args], {
  env: { PATH: bin + ':' + process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8'
});

test('Sicherung wird verschlüsselt abgelegt und lässt sich in eine Testdatenbank zurückspielen', { skip }, () => {
  const { dir, bin } = setup();
  const dest = path.join(dir, 'ziel');
  const env = { DATABASE_URL: 'postgres://attrappe/produktion', BACKUP_PASSPHRASE: 'test-passphrase', RESTORE_OUT: path.join(dir, 'out.txt') };
  const r = run([dest], env, bin);
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(path.join(dest, 'daily'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^rhetoriq-\d{4}-\d{2}-\d{2}\.dump\.enc$/);
  const raw = fs.readFileSync(path.join(dest, 'daily', files[0]));
  assert.ok(!raw.includes('SHIM-DUMP-INHALT'), 'Inhalt ist verschlüsselt');
  // Wiederherstellung: nie in die Produktionsdatenbank
  const same = run(['--restore', path.join(dest, 'daily', files[0])], { ...env, RESTORE_DATABASE_URL: env.DATABASE_URL }, bin);
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /nicht die Produktionsdatenbank/);
  const ok = run(['--restore', path.join(dest, 'daily', files[0])], { ...env, RESTORE_DATABASE_URL: 'postgres://attrappe/test' }, bin);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(env.RESTORE_OUT, 'utf8'), /SHIM-DUMP-INHALT/);
});

test('Ohne Schlüssel und Passphrase wird nie unverschlüsselt gesichert', { skip }, () => {
  const { dir, bin } = setup();
  const r = run([path.join(dir, 'ziel')], { DATABASE_URL: 'postgres://attrappe' }, bin);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nie unverschlüsselt/);
  const left = fs.existsSync(path.join(dir, 'ziel', 'daily')) ? fs.readdirSync(path.join(dir, 'ziel', 'daily')).filter(f => !f.endsWith('.part')) : [];
  assert.equal(left.length, 0);
});

test('Fehler von pg_dump und winzige Dateien gelten als Fehlschlag', { skip }, () => {
  const { dir, bin } = setup();
  const base = { DATABASE_URL: 'postgres://attrappe', BACKUP_PASSPHRASE: 'x' };
  assert.notEqual(run([path.join(dir, 'a')], { ...base, SHIM_FAIL: '1' }, bin).status, 0);
  assert.notEqual(run([path.join(dir, 'b')], { ...base, SHIM_TINY: '1' }, bin).status, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'b', 'daily')).filter(f => f.endsWith('.enc')).length, 0);
});

test('Aufbewahrung: alte Sicherungen werden entfernt', { skip }, () => {
  const { dir, bin } = setup();
  const dest = path.join(dir, 'ziel');
  fs.mkdirSync(path.join(dest, 'daily'), { recursive: true });
  const alt = path.join(dest, 'daily', 'rhetoriq-2020-01-01.dump.enc');
  fs.writeFileSync(alt, 'alt');
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(alt, old, old);
  const r = run([dest], { DATABASE_URL: 'postgres://attrappe', BACKUP_PASSPHRASE: 'x' }, bin);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(alt));
  assert.equal(fs.readdirSync(path.join(dest, 'daily')).length, 1);
});
