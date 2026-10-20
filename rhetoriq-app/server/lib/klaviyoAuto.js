// Automatische Ablage nach der Freigabe: Gibt die Beraterin einen Newsletter frei, den ein Klient mit «An Beraterin senden»
// geschickt hat, und ist Klaviyo verbunden und eine Liste samt Absender gemerkt, liegt der Entwurf danach in Klaviyo.
// Es wird nie versendet. Wirft nie: Fehler stehen nur im Log (ohne Schlüssel).
const { pool } = require('../db');
const store = require('./klaviyoStore');
const kl = require('./klaviyoApi');
const { uebertrage, voreinstellung } = require('./klaviyoUebertragung');
const { scrubText } = require('./scrub');

async function nachFreigabe(review, text) {
  try {
    if (!review || !text) return null;
    const ist = String(review.module_tile || '').toLowerCase() === 'newsletter' || /newsletter/i.test(String(review.module_label || ''));
    if (!ist) return null;
    const clientId = Number(review.client_id);
    const key = await store.lade('client', clientId);
    if (!key) return null;
    const vor = await voreinstellung(clientId);
    if (!vor) return null;
    const schon = await pool.query('SELECT 1 FROM klaviyo_uebertragungen WHERE client_id=$1 AND review_id=$2 LIMIT 1', [clientId, review.id]);
    if (schon.rows.length) return null;
    return await uebertrage({ key, clientId, reviewId: review.id, text, kampagne: vor });
  } catch (e) {
    console.error('[klaviyo] automatische Ablage:', scrubText(e && e.message), e instanceof kl.KlaviyoFehler ? e.code : '');
    return null;
  }
}

module.exports = { nachFreigabe };
