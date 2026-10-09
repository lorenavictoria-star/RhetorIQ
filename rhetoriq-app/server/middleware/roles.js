// Teamrollen im Server durchsetzen (Befund F-06).
// Stufen: viewer (nur lesen) < editor (schreiben) < admin (Abo, Team, Gedächtnis löschen).
// Der Hauptzugang eines Klienten (Token ohne clientUserId) hat die Rechte von admin, die Beraterin sowieso alle.
// Eine fehlende oder unbekannte Rolle bei Teammitgliedern zählt als editor (ältere Einträge sollen nicht ausgesperrt werden).
const RANK = { viewer: 1, editor: 2, admin: 3 };

function effectiveRank(user) {
  if (!user) return 0;
  if (user.role === 'advisor') return 99;
  if (user.role !== 'client') return 0;
  if (!user.clientUserId) return RANK.admin; // Hauptzugang
  return RANK[user.clientUserRole] || RANK.editor;
}

function isMainAccountOrAdvisor(user) {
  return !!user && (user.role === 'advisor' || (user.role === 'client' && !user.clientUserId));
}

// Nach requireAuth einsetzen: requireRole('editor') für Schreibzugriffe, requireRole('admin') für Abo und Team.
function requireRole(min) {
  const need = RANK[min];
  if (!need) throw new Error('Unbekannte Rolle: ' + min);
  return (req, res, next) => {
    if (effectiveRank(req.user) >= need) return next();
    const msg = need >= RANK.admin
      ? 'Das darf nur die Rolle Admin oder der Hauptzugang.'
      : 'Mit der Rolle Betrachter lässt sich hier nichts ändern.';
    return res.status(403).json({ error: msg });
  };
}

// Nur Hauptzugang oder Beraterin (kein Teammitglied), zum Beispiel für das Hauptpasswort
function requireMainAccount(req, res, next) {
  if (isMainAccountOrAdvisor(req.user)) return next();
  return res.status(403).json({ error: 'Das darf nur der Hauptzugang.' });
}

module.exports = { requireRole, requireMainAccount, effectiveRank, isMainAccountOrAdvisor, RANK };
