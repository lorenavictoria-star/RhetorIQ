// Selbst verwaltetes Abo: ein zentraler Check vor jeder KI-Textgenerierung, Nutzungsanzeige, Hinweise und Mails bei 80 und 100 Prozent.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');

// ~5'000 Tokens je Text (wie das Kontingent der Pakete gerechnet ist, routes/subscriptions.js)
const TOKENS_PRO_TEXT = 5000;
// Klienten, die ab diesem Datum angelegt wurden, brauchen ein Abo (Status «trial» ohne Zahlung sperrt). Frühere Klienten bleiben unberührt.
// Per Umgebungsvariable ABO_PFLICHT_AB (Datum) änderbar.
function pflichtAb() {
  const d = new Date(process.env.ABO_PFLICHT_AB || '2026-10-10T00:00:00Z');
  return isNaN(d.getTime()) ? new Date('2026-10-10T00:00:00Z') : d;
}

// Gratis-Test: Dauer und Anzahl Texte (Umgebungsvariablen GRATIS_TEST_TAGE und GRATIS_TEST_TEXTE)
const TEST_TAGE = parseInt(process.env.GRATIS_TEST_TAGE, 10) || 14;
const TEST_TEXTE = parseInt(process.env.GRATIS_TEST_TEXTE, 10) || 10;

const MELDUNG = {
  trial_abgelaufen: `Ihre Testzeit von ${TEST_TAGE} Tagen ist abgelaufen. Bitte schliessen Sie ein Abo ab, um weiterzuarbeiten.`,
  trial_texte: `Sie haben alle ${TEST_TEXTE} Testtexte genutzt. Bitte schliessen Sie ein Abo ab, um weiterzuarbeiten.`,
  kein_abo: 'Bitte schliessen Sie zuerst ein Abo ab.',
  audit_abgelaufen: 'Ihr Stimm-Audit-Zeitraum ist abgelaufen. Bitte schliessen Sie ein Abo ab.',
  cancelled: 'Ihr Abo ist nicht mehr aktiv. Bitte schliessen Sie ein neues Abo ab.',
  pending_plan: 'Bitte schliessen Sie zuerst ein Abo ab.'
};

function testAktiv(row) { return !!(row && row.gratis_test === true && (row.subscription_status || 'trial') === 'trial'); }
function testEnde(row) { return row && row.trial_start ? new Date(new Date(row.trial_start).getTime() + TEST_TAGE * 86400000) : null; }

// Der Test beginnt beim ersten Login der Klientin oder des Klienten. Wirft nie.
async function starteTest(clientId) {
  try {
    await ensureSchema();
    await pool.query('UPDATE clients SET trial_start=NOW() WHERE id=$1 AND gratis_test=true AND trial_start IS NULL', [clientId]);
  } catch (e) { console.error('[abo] Teststart:', e.message); }
}

// Stand des Gratis-Tests: { aktiv, gestartet, ende, tageRest, texteGenutzt, texteMax }
async function teststand(row) {
  if (!testAktiv(row)) return { aktiv: false };
  const ende = testEnde(row);
  let genutzt = 0;
  if (row.trial_start) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM analyses WHERE client_id=$1 AND created_at >= $2', [row.id, row.trial_start]);
    genutzt = Number(rows[0].n) || 0;
  }
  const tageRest = ende ? Math.max(0, Math.ceil((ende - new Date()) / 86400000)) : TEST_TAGE;
  return { aktiv: true, gestartet: !!row.trial_start, ende, tageRest, texteGenutzt: genutzt, texteMax: TEST_TEXTE };
}

// Vor jeder Textgenerierung für Klienten im Gratis-Test: startet den Test, falls noch nicht gestartet, prüft Textgrenze.
// Rückgabe { ok:true, warnung } oder { ok:false, zg }
async function testPruefung(row) {
  if (!testAktiv(row)) return { ok: true, warnung: null };
  let r = row;
  if (!row.trial_start) { await starteTest(row.id); r = { ...row, trial_start: new Date() }; }
  const st = await teststand(r);
  if (st.texteGenutzt >= st.texteMax) return { ok: false, zg: { ok: false, grund: 'trial_texte', error: MELDUNG.trial_texte } };
  const rest = st.texteMax - st.texteGenutzt - 1;   // nach dem Text, der jetzt erzeugt wird
  return { ok: true, warnung: `Gratis-Test: noch ${rest} von ${st.texteMax} Texten und ${st.tageRest} Tage.` };
}

// Prüft, ob für diesen Klienten Texte erzeugt werden dürfen. row: Zeile aus clients. advisor: Zugriff der Beraterin (neue Regeln gelten nicht für sie).
// Rückgabe: { ok:true } oder { ok:false, grund, error }
function zugang(row, { advisor = false, jetzt = new Date() } = {}) {
  if (!row) return { ok: true };
  const st = row.subscription_status || 'trial';
  if (st === 'cancelled') return { ok: false, grund: 'cancelled', error: MELDUNG.cancelled };
  if (st === 'pending_plan') return { ok: false, grund: 'pending_plan', error: MELDUNG.pending_plan };
  if (advisor) return { ok: true };
  if (row.zugang_bis && new Date(row.zugang_bis) < jetzt) return { ok: false, grund: 'audit_abgelaufen', error: MELDUNG.audit_abgelaufen };
  if (st === 'trial' && row.gratis_test === true) {
    // Gratis-Test: läuft ab dem ersten Login; die Textgrenze prüft testPruefung (braucht die Datenbank)
    const ende = testEnde(row);
    if (ende && ende < jetzt) return { ok: false, grund: 'trial_abgelaufen', error: MELDUNG.trial_abgelaufen };
    return { ok: true };
  }
  if (st === 'trial' && row.created_at && new Date(row.created_at) >= pflichtAb()) return { ok: false, grund: 'kein_abo', error: MELDUNG.kein_abo };
  return { ok: true };
}

// Antwort für die Generierungs-Routen (HTTP 402); die älteren Merker bleiben für die bestehende Oberfläche erhalten
function antwort402(z, clientId) {
  return {
    error: z.error, aboRequired: true, grund: z.grund, clientId,
    ...(z.grund === 'cancelled' ? { subscriptionCancelled: true } : {}),
    ...(z.grund === 'pending_plan' ? { pendingPlan: true } : {})
  };
}

async function clientRow(clientId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT id, name, email, monthly_token_limit, subscription_status, stripe_customer_id, zugang_bis, created_at, abo_mail_log, gratis_test, trial_start FROM clients WHERE id=$1', [clientId]);
  return rows[0] || null;
}

// Verbrauch im laufenden Monat in Tokens, Kontingent inklusive Zusatzpaketen dieses Monats
async function verbrauch(clientId, baseLimit) {
  const { rows: t } = await pool.query(
    `SELECT COALESCE(SUM(tokens),0)::bigint AS n FROM usage_topups WHERE client_id=$1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`, [clientId]);
  const { rows: u } = await pool.query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens),0)::bigint AS n FROM usage_log WHERE client_id=$1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`, [clientId]);
  const topup = Number(t[0].n), used = Number(u[0].n);
  const unbegrenzt = !baseLimit;
  const limit = unbegrenzt ? null : Number(baseLimit) + topup;
  return { used, limit, topup, unbegrenzt, prozent: unbegrenzt ? 0 : Math.min(100, Math.floor(used / limit * 100)) };
}

function texte(tokens) { return Math.floor(Number(tokens) / TOKENS_PRO_TEXT); }

// Hinweise für die Admin-Person des Klienten: Stufe 'warn' (80 Prozent) oder 'stop' (100 Prozent, kein Abo, Zahlung fehlgeschlagen)
function hinweise(row, v, jetzt = new Date()) {
  const out = [];
  const z = zugang(row, { jetzt });
  const st = row.subscription_status || 'trial';
  if (!z.ok) out.push({ art: z.grund, stufe: 'stop', text: z.error });
  else if (st === 'past_due') out.push({ art: 'zahlung', stufe: 'stop', text: 'Die letzte Zahlung ist fehlgeschlagen. Bitte prüfen Sie Ihre Zahlungsmethode im Kundenportal.' });
  else if (row.zugang_bis) {
    const tage = Math.ceil((new Date(row.zugang_bis) - jetzt) / 86400000);
    if (tage <= 7) out.push({ art: 'audit_ende', stufe: 'warn', text: `Ihr Stimm-Audit-Zeitraum endet in ${Math.max(tage, 0)} Tagen. Schliessen Sie jetzt Ihr Abo ab, damit Sie ohne Unterbruch weiterarbeiten.` });
  }
  if (z.ok && !v.unbegrenzt) {
    if (v.used >= v.limit) out.push({ art: 'kontingent100', stufe: 'stop', text: 'Ihr Kontingent für diesen Monat ist aufgebraucht. Ein Zusatzpaket oder ein höheres Paket bringt Sie sofort weiter.' });
    else if (v.used >= v.limit * 0.8) out.push({ art: 'kontingent80', stufe: 'warn', text: `Ihr Kontingent ist zu ${v.prozent} Prozent verbraucht. Es bleiben ${texte(v.limit - v.used)} Texte in diesem Monat.` });
  }
  return out;
}

// Einmal pro Schwelle und Monat eine Mail an Hauptzugang und Admin-Personen. Wirft nie.
async function pruefeSchwellen(clientId) {
  try {
    const row = await clientRow(clientId);
    if (!row || !row.monthly_token_limit) return;
    if (!zugang(row).ok) return;
    const v = await verbrauch(clientId, row.monthly_token_limit);
    const stufe = v.used >= v.limit ? 100 : v.used >= v.limit * 0.8 ? 80 : 0;
    if (!stufe) return;
    const monat = new Date().toISOString().slice(0, 7);
    const marke = `${monat}:${stufe}`;
    const log = String(row.abo_mail_log || '');
    if (log.split(',').includes(marke)) return;
    // Nur Marken des laufenden Monats behalten; der Wert muss sich gegenüber dem Lesen noch nicht verändert haben
    const neu = log.split(',').filter(x => x.startsWith(monat)).concat(marke).join(',');
    const upd = await pool.query('UPDATE clients SET abo_mail_log=$2 WHERE id=$1 AND COALESCE(abo_mail_log,\'\')=$3 RETURNING id', [clientId, neu, log]);
    if (!upd.rows.length) return;
    const an = new Set();
    if (row.email) an.add(String(row.email).trim());
    try {
      const { rows } = await pool.query(`SELECT email FROM client_users WHERE client_id=$1 AND role='admin'`, [clientId]);
      rows.forEach(r => r.email && an.add(String(r.email).trim()));
    } catch { /* Spalte oder Tabelle fehlt: nur Hauptadresse */ }
    const text = stufe === 100
      ? `Guten Tag\n\nIhr Kontingent für diesen Monat ist aufgebraucht (${texte(v.used)} von ${texte(v.limit)} Texten). Neue Texte sind erst wieder möglich, wenn Sie ein Zusatzpaket (+20 Texte, CHF 49) buchen oder auf ein höheres Paket wechseln.\n\nUnter «Abo verwalten» in RhetorIQ erledigen Sie das in wenigen Klicks.\n\nFreundliche Grüsse\nRhetorIQ`
      : `Guten Tag\n\nIhr Kontingent ist zu ${v.prozent} Prozent verbraucht (${texte(v.used)} von ${texte(v.limit)} Texten). Damit Sie ohne Unterbruch weiterarbeiten können, lohnt sich jetzt ein Blick auf «Abo verwalten» in RhetorIQ.\n\nFreundliche Grüsse\nRhetorIQ`;
    const subject = stufe === 100 ? 'RhetorIQ: Ihr Kontingent ist aufgebraucht' : 'RhetorIQ: Ihr Kontingent ist zu 80 Prozent verbraucht';
    const { brevoSend } = require('./brevo');
    for (const to of an) {
      try { await brevoSend({ to, subject, text, senderName: 'RhetorIQ' }); }
      catch (e) { console.error('[abo] Mail an', to, 'fehlgeschlagen:', e.message); }
    }
  } catch (e) {
    console.error('[abo] Schwellenprüfung fehlgeschlagen:', e.message);
  }
}

module.exports = { TEST_TAGE, TEST_TEXTE, testAktiv, testEnde, starteTest, teststand, testPruefung, TOKENS_PRO_TEXT, MELDUNG, zugang, antwort402, clientRow, verbrauch, texte, hinweise, pruefeSchwellen, pflichtAb };
