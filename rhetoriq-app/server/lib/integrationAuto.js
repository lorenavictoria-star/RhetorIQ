// Automatische Ablage nach der Freigabe in Brevo oder Mailchimp: wie lib/klaviyoAuto.js, je Anbieter mit gemerkter Liste und Absender.
// Es wird nie versendet. Wirft nie.
const { pool } = require('../db');
const I = require('./integrationen');
const { scrubText } = require('./scrub');

async function nachFreigabe(review, text) {
  try {
    if (!review || !text) return [];
    const ist = String(review.module_tile || '').toLowerCase() === 'newsletter' || /newsletter/i.test(String(review.module_label || ''));
    if (!ist) return [];
    const clientId = Number(review.client_id);
    const out = [];
    for (const name of Object.keys(I.ANBIETER).filter(n => I.ANBIETER[n].art === 'newsletter')) {
      try {
        const vor = await I.voreinstellung(clientId, name);
        if (!vor || !I.kampagneGueltig(vor) || !(await I.lade(clientId, name))) continue;
        const schon = await pool.query('SELECT 1 FROM integration_uebertragungen WHERE client_id=$1 AND anbieter=$2 AND review_id=$3 LIMIT 1', [clientId, name, review.id]);
        if (schon.rows.length) continue;
        out.push(await I.entwurfAnlegen(clientId, name, { text, kampagne: vor, reviewId: review.id }));
      } catch (e) { console.error('[integration] automatische Ablage', name + ':', scrubText(e && e.message)); }
    }
    return out;
  } catch (e) {
    console.error('[integration] automatische Ablage:', scrubText(e && e.message));
    return [];
  }
}
module.exports = { nachFreigabe };
