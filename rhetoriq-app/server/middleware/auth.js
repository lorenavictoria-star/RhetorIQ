const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Look up the current token_version for whoever this payload represents, so
// a stolen/old token can be revoked server-side before its natural expiry
// (e.g. on password change, or an advisor cutting off a client's access).
async function currentTokenVersion(payload) {
  if (payload.role === 'advisor') {
    const { rows } = await pool.query('SELECT token_version FROM users WHERE id=$1', [payload.id]);
    return rows[0]?.token_version;
  }
  if (payload.role === 'client' && payload.clientUserId) {
    const { rows } = await pool.query('SELECT token_version FROM client_users WHERE id=$1', [payload.clientUserId]);
    return rows[0]?.token_version;
  }
  if (payload.role === 'client') {
    const { rows } = await pool.query('SELECT token_version FROM clients WHERE id=$1', [payload.clientId]);
    return rows[0]?.token_version;
  }
  return undefined;
}

async function requireAdvisor(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'advisor') return res.status(403).json({ error: 'Advisor only' });
    const liveVersion = await currentTokenVersion(payload);
    if (liveVersion === undefined || (payload.tokenVersion || 1) !== liveVersion) {
      return res.status(401).json({ error: 'Session revoked — please log in again.' });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const liveVersion = await currentTokenVersion(payload);
    if (liveVersion === undefined || (payload.tokenVersion || 1) !== liveVersion) {
      return res.status(401).json({ error: 'Session revoked — please log in again.' });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requireAdvisor, requireAuth };
