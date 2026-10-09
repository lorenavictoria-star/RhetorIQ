// Jahreszahlung: 10 Prozent Rabatt (Business: zwei Monate gratis). Das Paket ergibt sich aus clients.monthly_token_limit.
// Frühere Abos (300000 und 1500000) und Enterprise werden nicht angeboten.
const YEARLY = [
  { name: 'Stimme', tokens: 200000, monthlyCents: 19000, yearlyCents: Math.round(19000 * 12 * 0.9) },   // CHF 2'052
  { name: 'Team', tokens: 750000, monthlyCents: 59000, yearlyCents: Math.round(59000 * 12 * 0.9) },     // CHF 6'372
  { name: 'Business', tokens: 2000000, monthlyCents: 149000, yearlyCents: 149000 * 10 },               // CHF 14'900
];

function yearlyOfferFor(monthlyTokenLimit) {
  if (!monthlyTokenLimit) return null;
  return YEARLY.find(t => t.tokens === Number(monthlyTokenLimit)) || null;
}

// Betrag in Rappen (Jahrespreis) auf das Monatskontingent abbilden, undefined wenn unbekannt
function resolveYearlyLimit(amountInCents, currency) {
  if (!amountInCents || (currency || '').toLowerCase() !== 'chf') return undefined;
  const t = YEARLY.find(x => x.yearlyCents === amountInCents);
  return t ? t.tokens : undefined;
}

// stripe ist austauschbar (Tests). Gibt { url, tier, amountCents } zurück.
async function createYearlyLink(stripe, client, offer) {
  const link = await stripe.paymentLinks.create({
    line_items: [{
      price_data: {
        currency: 'chf',
        unit_amount: offer.yearlyCents,
        recurring: { interval: 'year' },
        product_data: { name: `RhetorIQ ${offer.name} Jahresabo, ${client.name}` },
      },
      quantity: 1,
    }],
    metadata: { clientId: String(client.id), clientName: client.name, type: 'yearly', targetTier: offer.name },
  });
  return { url: link.url, tier: offer.name, amountCents: offer.yearlyCents, monthlyCents: offer.monthlyCents };
}

module.exports = { YEARLY, yearlyOfferFor, resolveYearlyLimit, createYearlyLink };
