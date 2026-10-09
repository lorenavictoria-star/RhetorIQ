const { pool } = require('../db');

// Zugriff auf Klientendaten: Die Beraterin darf alle ihre Klienten, ein Klient (und seine Teammitglieder) nur sich selbst.
// Diese Prüfung gehört an jede Route, die eine Klienten-Nummer aus der Anfrage übernimmt. Die Nummer aus der Anfrage
// ist nie vertrauenswürdig, nur das Anmelde-Token.

async function canAccessClient(req, clientId) {
  const id = parseInt(clientId, 10);
  if (!req.user || !Number.isInteger(id)) return false;
  if (req.user.role === 'client') return Number(req.user.clientId) === id;
  if (req.user.role === 'advisor') {
    // Klienten ohne eingetragene Beraterin (ältere Daten) bleiben für die Beraterin erreichbar
    const { rows } = await pool.query('SELECT advisor_id FROM clients WHERE id=$1', [id]);
    return rows.length > 0 && (rows[0].advisor_id == null || Number(rows[0].advisor_id) === Number(req.user.id));
  }
  return false;
}

// Middleware: der Pfadparameter (zum Beispiel :clientId) muss für diese Person erlaubt sein
function ownClient(param = 'clientId') {
  return async (req, res, next) => {
    try {
      if (await canAccessClient(req, req.params[param])) return next();
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    } catch (e) {
      console.error('[ownership]', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Die Klienten-Nummer, mit der gearbeitet werden darf: Klienten immer die eigene, die Beraterin die angefragte,
// wenn sie ihr gehört. Gibt null zurück, wenn nichts Erlaubtes übrig bleibt.
async function allowedClientId(req, requested) {
  if (req.user.role === 'client') return Number(req.user.clientId) || null;
  if (requested == null || requested === '') return null;
  return (await canAccessClient(req, requested)) ? parseInt(requested, 10) : null;
}

async function canAccessPerson(req, personId) {
  const id = parseInt(personId, 10);
  if (!Number.isInteger(id)) return false;
  const { rows } = await pool.query('SELECT client_id FROM people WHERE id=$1', [id]);
  return rows[0] ? canAccessClient(req, rows[0].client_id) : false;
}
function ownPerson(param = 'id') {
  return async (req, res, next) => {
    try {
      if (await canAccessPerson(req, req.params[param])) return next();
      return res.status(403).json({ error: 'Kein Zugriff auf diese Person.' });
    } catch (e) {
      console.error('[ownership]', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Wie ownClient, aber die Klienten-Nummer steht im Body oder in der Abfrage (req.body[field] oder req.query[field])
function ownClientBody(field = 'clientId') {
  return async (req, res, next) => {
    try {
      const v = (req.body && req.body[field] != null) ? req.body[field] : (req.query || {})[field];
      if (await canAccessClient(req, v)) return next();
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Klienten.' });
    } catch (e) {
      console.error('[ownership]', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = { ownClientBody, canAccessClient, ownClient, allowedClientId, canAccessPerson, ownPerson };
