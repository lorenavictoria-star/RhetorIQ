const bcrypt = require('bcrypt');
const { pool } = require('../db');

// Beraterin-Konto aus ADVISOR_EMAIL und ADVISOR_PASSWORD anlegen oder angleichen (beim Start).
// Ändert sich das Passwort in Render, wird token_version erhöht: gestohlene Sitzungen enden damit (Befund F-13).
// Bleibt das Passwort gleich, ändert sich nichts am Hash und an den Sitzungen.
async function seedAdvisor(env = process.env) {
  const email = env.ADVISOR_EMAIL;
  const password = env.ADVISOR_PASSWORD;
  const name = env.ADVISOR_NAME || 'Advisor';
  if (!email || !password) return { changed: false };

  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  if (rows[0] && rows[0].password_hash && await bcrypt.compare(password, rows[0].password_hash)) {
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, rows[0].id]);
    return { changed: false };
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) ' +
    'ON CONFLICT (email) DO UPDATE SET password_hash = $2, name = $3, token_version = users.token_version + 1',
    [email, hash, name, 'advisor']
  );
  return { changed: true };
}

module.exports = { seedAdvisor };
