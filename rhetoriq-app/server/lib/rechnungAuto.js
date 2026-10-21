// Rechnungen automatisch: neue Rechnung vor Ablauf der bezahlten Zeit erstellen und senden, Zahlungserinnerungen, Zahlungsabgleich
// mit der Bankdatei (camt.054 oder camt.053). Es wird nie ein Abo ohne eine vorherige bezahlte Rechnung automatisch begonnen.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const R = require('./rechnung');
const camt = require('./camt');
const { scrubText } = require('./scrub');

const ERINNERUNG1_NACH_TAGEN = 7;     // nach Fälligkeit
const ERINNERUNG2_NACH_TAGEN = 21;

async function holeAbo(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM rechnung_abo WHERE client_id=$1', [clientId]);
  const r = rows[0];
  if (!r) return { aktiv: false, posten: null, laufzeit: 'monat', empfaenger: null, vorlaufTage: 14 };
  let emp = null; try { emp = r.empfaenger ? JSON.parse(r.empfaenger) : null; } catch { emp = null; }
  return { aktiv: !!r.aktiv, posten: r.posten, laufzeit: r.laufzeit || 'monat', empfaenger: emp, bemerkung: r.bemerkung || '', vorlaufTage: Number(r.vorlauf_tage) || 14 };
}
async function setzeAbo(clientId, cfg) {
  const p = R.POSTEN[cfg.posten];
  if (cfg.aktiv && (!p || !p.laufzeit)) throw Object.assign(new Error('Automatische Rechnungen gibt es nur für die Pakete (Stimme, Team, Business, Enterprise).'), { status: 400 });
  const lz = cfg.laufzeit === 'jahr' ? 'jahr' : 'monat';
  const vorlauf = Math.min(60, Math.max(3, parseInt(cfg.vorlaufTage, 10) || 14));
  await ensureSchema();
  const emp = JSON.stringify(cfg.empfaenger || {});
  const up = await pool.query('UPDATE rechnung_abo SET aktiv=$2, posten=$3, laufzeit=$4, empfaenger=$5, bemerkung=$6, vorlauf_tage=$7, updated_at=NOW() WHERE client_id=$1',
    [clientId, !!cfg.aktiv, cfg.posten || null, lz, emp, cfg.bemerkung ? String(cfg.bemerkung).slice(0, 300) : null, vorlauf]);
  if (!up.rowCount) await pool.query('INSERT INTO rechnung_abo (client_id, aktiv, posten, laufzeit, empfaenger, bemerkung, vorlauf_tage) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [clientId, !!cfg.aktiv, cfg.posten || null, lz, emp, cfg.bemerkung ? String(cfg.bemerkung).slice(0, 300) : null, vorlauf]);
  return holeAbo(clientId);
}

// Neue Rechnungen: aktives Abo, bereits einmal bezahlt (bezahlt_bis gesetzt), Ende der bezahlten Zeit in höchstens «vorlauf» Tagen
// oder schon vorbei, keine offene Rechnung. Liefert die Liste der erstellten und gesendeten Rechnungen.
async function neueRechnungen(jetzt = new Date()) {
  await ensureSchema();
  const out = [];
  const { rows } = await pool.query(`SELECT a.*, c.bezahlt_bis, c.name, c.geloescht_am FROM rechnung_abo a JOIN clients c ON c.id=a.client_id WHERE a.aktiv=true`);
  for (const a of rows) {
    try {
      if (a.geloescht_am || !a.bezahlt_bis) continue;
      const bis = new Date(a.bezahlt_bis);
      if ((bis - jetzt) / 86400000 > (Number(a.vorlauf_tage) || 14)) continue;
      const { rows: offen } = await pool.query(`SELECT 1 FROM rechnungen WHERE client_id=$1 AND status='offen' LIMIT 1`, [a.client_id]);
      if (offen.length) continue;
      let emp = {}; try { emp = a.empfaenger ? JSON.parse(a.empfaenger) : {}; } catch { emp = {}; }
      const r = await R.legeAn({ clientId: a.client_id, posten: a.posten, laufzeit: a.laufzeit, empfaenger: emp, bemerkung: a.bemerkung || undefined });
      await pool.query('UPDATE rechnungen SET auto=true WHERE id=$1', [r.id]);
      let gesendet = false, grund = null;
      try { await R.sendeRechnung(r); gesendet = true; } catch (e) { grund = e.message; }
      out.push({ nummer: r.nummer, client: a.name, betragRappen: r.betrag_rappen, gesendet, grund });
    } catch (e) {
      out.push({ client: a.name, fehler: scrubText(e && e.message) });
    }
  }
  return out;
}

// Zahlungserinnerungen: offene Rechnungen 7 und 21 Tage nach Fälligkeit, je einmal
async function erinnerungen(jetzt = new Date()) {
  await ensureSchema();
  const out = [];
  const { rows } = await pool.query(`SELECT * FROM rechnungen WHERE status='offen' AND faellig_am IS NOT NULL ORDER BY id`);
  for (const r of rows) {
    const tage = (jetzt - new Date(r.faellig_am)) / 86400000;
    const stufe = tage >= ERINNERUNG2_NACH_TAGEN ? 2 : tage >= ERINNERUNG1_NACH_TAGEN ? 1 : 0;
    if (stufe <= (r.mahnung_stufe || 0)) continue;
    try {
      await R.sendeRechnung(r, { art: stufe === 2 ? 'erinnerung2' : 'erinnerung1' });
      await pool.query('UPDATE rechnungen SET mahnung_stufe=$2, mahnung_am=NOW() WHERE id=$1', [r.id, stufe]);
      out.push({ nummer: r.nummer, stufe });
    } catch (e) { out.push({ nummer: r.nummer, stufe, fehler: scrubText(e && e.message) }); }
  }
  return out;
}

// Zahlungsabgleich mit der Bankdatei. Gutschrift mit Referenz und passendem Betrag: Rechnung wird als bezahlt markiert,
// der Klient erhält eine Bestätigung. Abweichender Betrag oder unbekannte Referenz: nur Meldung, nichts wird geändert.
async function abgleichen(xml, { bestaetigen = true } = {}) {
  await ensureSchema();
  const eintraege = camt.lies(xml);
  const res = { gelesen: eintraege.length, bezahlt: [], bereitsBezahlt: [], abweichend: [], unbekannt: [] };
  for (const z of eintraege) {
    const { rows } = await pool.query(`SELECT * FROM rechnungen WHERE referenz=$1`, [z.referenz]);
    const r = rows[0];
    if (!r) { res.unbekannt.push({ referenz: z.referenz, betragRappen: z.betragRappen, zahler: z.zahler }); continue; }
    if (r.status === 'bezahlt') { res.bereitsBezahlt.push({ nummer: r.nummer }); continue; }
    if (r.status === 'storniert' || z.waehrung !== 'CHF' || z.betragRappen !== r.betrag_rappen) {
      res.abweichend.push({ nummer: r.nummer, erwartetRappen: r.betrag_rappen, erhaltenRappen: z.betragRappen, waehrung: z.waehrung, status: r.status });
      continue;
    }
    await R.alsBezahltMarkieren(r.id, { bezahltAm: z.datum || undefined });
    res.bezahlt.push({ nummer: r.nummer, betragRappen: r.betrag_rappen, datum: z.datum });
    if (bestaetigen) {
      try {
        const { queueEmail } = require('./emailOutbox');
        const { rows: c } = await pool.query('SELECT name, email, bezahlt_bis FROM clients WHERE id=$1', [r.client_id]);
        const e = await R.holeEinstellungen();
        if (c[0] && c[0].email) {
          await queueEmail({ kind: 'rechnung', to: c[0].email, subject: `Zahlung zur Rechnung ${r.nummer} erhalten`, senderName: e.name,
            text: `Guten Tag\n\nIhre Zahlung zur Rechnung ${r.nummer} (CHF ${R.chf(r.betrag_rappen)}) ist bei mir eingegangen. Herzlichen Dank.\n\n`
              + (c[0].bezahlt_bis ? `Ihr Abo ist bis zum ${R.datum(c[0].bezahlt_bis)} bezahlt.\n\n` : '') + `Freundliche Grüsse\n${e.name}` });
        }
      } catch (e) { console.error('[rechnung] Bestätigung:', scrubText(e && e.message)); }
    }
  }
  return res;
}

// Täglicher Lauf: neue Rechnungen, Erinnerungen, Zusammenfassung an die Beraterin (nur wenn etwas geschehen ist oder etwas offen und überfällig ist)
async function taeglich(jetzt = new Date()) {
  const neu = await neueRechnungen(jetzt);
  const erinn = await erinnerungen(jetzt);
  if (neu.length || erinn.length) {
    try {
      const e = await R.holeEinstellungen();
      if (e.email) {
        const zeilen = [
          ...neu.map(n => n.fehler ? `Fehler bei ${n.client}: ${n.fehler}` : `Neue Rechnung ${n.nummer} für ${n.client}, CHF ${R.chf(n.betragRappen)}${n.gesendet ? ', per Mail gesendet' : ', NICHT gesendet (' + n.grund + ')'}`),
          ...erinn.map(x => x.fehler ? `Fehler bei Erinnerung ${x.nummer}: ${x.fehler}` : `Zahlungserinnerung ${x.stufe} zu ${x.nummer} gesendet`)
        ];
        const { queueEmail } = require('./emailOutbox');
        await queueEmail({ kind: 'rechnung-info', to: e.email, subject: 'RhetorIQ: Rechnungen heute', senderName: 'RhetorIQ', text: `Guten Tag\n\n${zeilen.join('\n')}\n\nSobald eine Zahlung eingegangen ist, markierst du die Rechnung in der Verwaltung des Klienten als bezahlt.` });
      }
    } catch (err) { console.error('[rechnung] Zusammenfassung:', scrubText(err && err.message)); }
  }
  return { neu, erinnerungen: erinn };
}

module.exports = { holeAbo, setzeAbo, neueRechnungen, erinnerungen, abgleichen, taeglich, ERINNERUNG1_NACH_TAGEN, ERINNERUNG2_NACH_TAGEN };
