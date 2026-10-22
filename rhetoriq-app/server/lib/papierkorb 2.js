// Papierkorb für gelöschte Klienten (Ausfallbericht, Szenario 4): Löschen setzt clients.geloescht_am, der Klient
// verschwindet aus allen Listen und kann sich nicht mehr anmelden. Wiederherstellen setzt die Markierung zurück.
// Erst nach 30 Tagen löscht ein Job endgültig (lib/clientData.js, die vollständige Löschroutine aus F-10).
const { pool } = require('../db');

const FRIST_TAGE = 30;

// Klient in den Papierkorb legen. Meldet alle Sitzungen ab (token_version erhöht). Gibt null zurück, wenn nicht gefunden.
async function inPapierkorb(clientId, advisorId) {
  const { rows } = await pool.query(
    `UPDATE clients SET geloescht_am = NOW(), token_version = COALESCE(token_version, 1) + 1
     WHERE id=$1 AND advisor_id=$2 AND geloescht_am IS NULL RETURNING id, name`, [clientId, advisorId]);
  return rows[0] || null;
}

async function liste(advisorId) {
  const { rows } = await pool.query(
    `SELECT id, name, industry, geloescht_am FROM clients WHERE advisor_id=$1 AND geloescht_am IS NOT NULL ORDER BY geloescht_am DESC`, [advisorId]);
  const jetzt = Date.now();
  return rows.map(r => {
    const bis = new Date(new Date(r.geloescht_am).getTime() + FRIST_TAGE * 86400000);
    return { id: r.id, name: r.name, industry: r.industry, geloeschtAm: r.geloescht_am, endgueltigAm: bis.toISOString(), tageBleiben: Math.max(0, Math.ceil((bis.getTime() - jetzt) / 86400000)) };
  });
}

async function wiederherstellen(clientId, advisorId) {
  const { rows } = await pool.query(
    `UPDATE clients SET geloescht_am = NULL WHERE id=$1 AND advisor_id=$2 AND geloescht_am IS NOT NULL RETURNING id, name`, [clientId, advisorId]);
  return rows[0] || null;
}

// Nach Ablauf der Frist endgültig löschen. Gibt die Anzahl endgültig gelöschter Klienten zurück.
async function endgueltigNachFrist(jetzt = new Date()) {
  const grenze = new Date(jetzt.getTime() - FRIST_TAGE * 86400000);
  const { rows } = await pool.query(
    `SELECT id, advisor_id, name FROM clients WHERE geloescht_am IS NOT NULL AND geloescht_am < $1`, [grenze]);
  const { deleteClientCompletely } = require('./clientData');
  let n = 0;
  for (const c of rows) {
    try {
      if (c.advisor_id == null) continue; // ohne Beraterin kann die Löschroutine nicht prüfen, wem der Klient gehört
      const r = await deleteClientCompletely(c.id, c.advisor_id);
      if (r) { n++; console.log(`[papierkorb] Klient ${c.id} nach ${FRIST_TAGE} Tagen endgültig gelöscht`); }
    } catch (e) { console.error('[papierkorb] Löschen von Klient', c.id, 'fehlgeschlagen:', e.message); }
  }
  return n;
}

module.exports = { inPapierkorb, liste, wiederherstellen, endgueltigNachFrist, FRIST_TAGE };
