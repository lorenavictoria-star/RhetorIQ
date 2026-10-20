// Newsletter nach Klaviyo übertragen: HTML-Vorlage und auf Wunsch Kampagnenentwurf. Es wird NIE versendet.
// Genutzt vom Weg über die Freigabe (routes/klaviyo.js /senden), vom Direktweg aus dem Newsletter-Modul (/direkt)
// und von der automatischen Ablage nach der Freigabe durch die Beraterin (lib/klaviyoAuto.js).
const { pool } = require('../db');
const kl = require('./klaviyoApi');
const { baueHtml } = require('./newsletterHtml');

const LISTE_RE = /^[A-Za-z0-9]{3,30}$/;
const MAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

function kampagneGueltig(k) {
  return !!k && typeof k === 'object' && LISTE_RE.test(String(k.listId || '').trim()) && MAIL_RE.test(String(k.absenderEmail || '').trim());
}

async function voreinstellung(clientId) {
  const { rows } = await pool.query('SELECT liste_id, absender_email, absender_name FROM klaviyo_voreinstellung WHERE client_id=$1', [clientId]);
  const r = rows[0];
  return r ? { listId: r.liste_id, absenderEmail: r.absender_email, absenderName: r.absender_name || '' } : null;
}

async function merkeVoreinstellung(clientId, k) {
  const v = [clientId, String(k.listId).trim(), String(k.absenderEmail).trim(), String(k.absenderName || '').slice(0, 100)];
  const up = await pool.query('UPDATE klaviyo_voreinstellung SET liste_id=$2, absender_email=$3, absender_name=$4, updated_at=NOW() WHERE client_id=$1', v);
  if (!up.rowCount) await pool.query('INSERT INTO klaviyo_voreinstellung (client_id, liste_id, absender_email, absender_name) VALUES ($1,$2,$3,$4)', v);
}

// uebertrage({ key, clientId, reviewId?, text, kampagne?, du? }) -> { ok, vorlageName, vorlageId, kampagneId?, kampagneFehler?, hinweis }
// Wirft KlaviyoFehler, wenn schon die Vorlage nicht angelegt werden kann.
async function uebertrage({ key, clientId, reviewId = null, text, kampagne = null, du = false }) {
  const h = baueHtml(text, {});
  const betreff = h.betreff || 'Newsletter';
  const name = `${betreff.slice(0, 110)} (RhetorIQ ${new Date().toLocaleDateString('de-CH')})`;
  const out = { ok: true, vorlageName: name };
  out.vorlageId = await kl.legeVorlageAn(key, name, h.html, { du });
  if (kampagne && typeof kampagne === 'object') {
    if (!kampagneGueltig(kampagne)) {
      out.kampagneFehler = 'Für den Kampagnenentwurf braucht es eine Liste und eine gültige Absenderadresse. Die Vorlage ist angelegt.';
    } else {
      try {
        const c = await kl.legeKampagnenentwurfAn(key, { name, listId: String(kampagne.listId).trim(), betreff, vorschau: h.vorschau, absenderEmail: String(kampagne.absenderEmail).trim(), absenderName: String(kampagne.absenderName || '').slice(0, 100), vorlageId: out.vorlageId }, { du });
        out.kampagneId = c.kampagneId;
      } catch (e) {
        if (!(e instanceof kl.KlaviyoFehler)) throw e;
        out.kampagneFehler = `Der Kampagnenentwurf konnte nicht angelegt werden: ${e.message} Die Vorlage ist angelegt.`;
      }
    }
  }
  await pool.query('INSERT INTO klaviyo_uebertragungen (client_id, review_id, vorlage_id, kampagne_id) VALUES ($1,$2,$3,$4)', [clientId, reviewId, out.vorlageId || null, out.kampagneId || null]);
  out.hinweis = (out.kampagneId ? 'In Klaviyo liegen jetzt eine Vorlage und ein Kampagnenentwurf. ' : 'In Klaviyo liegt jetzt eine Vorlage. ') + 'Es wurde nichts versendet. Den Versand lösen Sie in Klaviyo selbst aus.';
  return out;
}

module.exports = { uebertrage, voreinstellung, merkeVoreinstellung, kampagneGueltig };
