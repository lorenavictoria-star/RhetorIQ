// Anbieter «ICS-Feed»: Der abonnierbare Kalender (webcal) wird bei jedem Abruf live aus der Datenbank gebaut.
// Deshalb gibt es nichts zu senden. Apple und Google holen den Feed in eigenem Takt (oft erst nach Stunden).
module.exports = {
  name: 'ics-feed',
  async push() { /* nichts zu tun, der Feed liest live */ },
  async delete() { /* nichts zu tun */ }
};
