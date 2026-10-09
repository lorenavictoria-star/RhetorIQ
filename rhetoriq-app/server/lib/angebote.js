// Angebote, für die die Beraterin einen Zahlungslink erzeugen kann, ohne vorher Preise in Stripe anzulegen.
// Der Preis steckt im Aufruf (price_data). Monatsabos setzen beim Zahlungseingang das Kontingent über den Betrag (routes/subscriptions.js).
const ANGEBOTE = {
  stimme:   { name: 'Paket Stimme', amountCents: 19000, recurring: true },
  team:     { name: 'Paket Team', amountCents: 59000, recurring: true },
  business: { name: 'Paket Business', amountCents: 149000, recurring: true },
  'stimm-audit':        { name: 'Stimm-Audit (30 Tage Zugang inklusive)', amountCents: 95000, recurring: false, einrichtung: true },
  'workshop-team':      { name: 'Workshop «Die Stimme finden» (Team)', amountCents: 390000, recurring: false, einrichtung: true },
  'workshop-business':  { name: 'Workshop «Die Stimme finden» (Business)', amountCents: 500000, recurring: false, einrichtung: true }
};
const LISTE = Object.keys(ANGEBOTE).map(k => ({ key: k, ...ANGEBOTE[k] }));
module.exports = { ANGEBOTE, LISTE };
