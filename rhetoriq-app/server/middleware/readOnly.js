const jwt = require('jsonwebtoken');

// "Ansicht des Klienten": Tokens mit readOnly:true (von POST /api/advisor/view-as/:clientId) dürfen nur lesen.
// Greift global vor allen Routen. Alle anderen Tokens (auch ohne Token oder mit ungültigem Token) laufen
// unverändert weiter; deren Prüfung bleibt Sache von requireAuth und requireAdvisor.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readOnlyGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  let payload = null;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch { return next(); }
  if (payload && payload.readOnly === true) return res.status(403).json({ error: 'Nur Ansicht' });
  next();
}

module.exports = { readOnlyGuard };
