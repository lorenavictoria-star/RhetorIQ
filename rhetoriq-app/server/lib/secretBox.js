// Verschlüsselte Ablage für Zugangsschlüssel Dritter (zum Beispiel der private Klaviyo-Schlüssel eines Klienten).
// AES-256-GCM. Der Hauptschlüssel kommt aus der Umgebungsvariable SECRETS_ENCRYPTION_KEY: genau 32 Byte, als 64 Hex-Zeichen
// oder als Base64. Erzeugen: openssl rand -hex 32 (einmal erzeugen, in Render eintragen, nie ändern und nie weitergeben).
// Ist die Variable nicht gesetzt oder ungültig, meldet available() false und encrypt() wirft einen Fehler mit code NO_SECRET.
// Es wird dann nichts gespeichert, auch nicht unverschlüsselt.
const crypto = require('crypto');

const VERSION = 'v1';

function masterKey() {
  const raw = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* ungültig */ }
  return null;
}

function available() { return !!masterKey(); }

function noSecret() {
  const e = new Error('Verschlüsselung nicht eingerichtet');
  e.code = 'NO_SECRET';
  return e;
}

// Gibt "v1.<iv>.<tag>.<geheimtext>" (Base64url) zurück
function encrypt(plain) {
  const key = masterKey();
  if (!key) throw noSecret();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

// Gibt den Klartext zurück oder wirft (code NO_SECRET oder BAD_SECRET)
function decrypt(blob) {
  const key = masterKey();
  if (!key) throw noSecret();
  const p = String(blob || '').split('.');
  if (p.length !== 4 || p[0] !== VERSION) { const e = new Error('Gespeicherter Wert ungültig'); e.code = 'BAD_SECRET'; throw e; }
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p[1], 'base64url'));
    d.setAuthTag(Buffer.from(p[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64url')), d.final()]).toString('utf8');
  } catch {
    const e = new Error('Gespeicherter Wert nicht lesbar');
    e.code = 'BAD_SECRET';
    throw e;
  }
}

module.exports = { available, encrypt, decrypt };
