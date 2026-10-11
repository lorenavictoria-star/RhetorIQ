// Datenzugriff und Ablauf der Terminbuchung: Einstellungen, freie Zeiten aus dem Kalender, Buchen, Verschieben, Absagen, Erinnerungen.
// Die Buchung selbst läuft unter einer Sperre (Prozess-Warteschlange plus Postgres-Advisory-Lock), die Prüfung der freien Zeit wird darin erneut gerechnet.
const { pool } = require('../db');
const Z = require('./zeit');
const T = require('./tagesplan');
const D = require('./tagesplanDaten');
const B = require('./buchung');
const M = require('./buchungMails');
const sync = require('./kalendersync');
const { queueEmail } = require('./emailOutbox');
const { advisorEmails } = require('./notify');

const TAGESLIMIT = 12;
const MAX_OFFEN = 2;
const LOCK_ID = 727301; // beliebige feste Zahl für den Advisory-Lock

let ensured = null;
function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await D.ensureSchema();
    await pool.query(`CREATE TABLE IF NOT EXISTS buchung_einstellungen (advisor_id INTEGER PRIMARY KEY, daten TEXT NOT NULL DEFAULT '{}')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS buchungen (
      id SERIAL PRIMARY KEY, advisor_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, anliegen TEXT NOT NULL DEFAULT '',
      start_at TIMESTAMPTZ NOT NULL, ende_at TIMESTAMPTZ NOT NULL, datum TEXT NOT NULL, beginn INTEGER NOT NULL, ende INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'gebucht', slot_key TEXT, token_hash TEXT, eintrag_id INTEGER, inquiry_id INTEGER,
      ursprung_id INTEGER, version INTEGER NOT NULL DEFAULT 0, erinnert_am TIMESTAMPTZ, abgesagt_von TEXT, storniert_am TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Eine Zeit kann nur einmal belegt sein: slot_key ist bei abgesagten Buchungen leer
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS buchungen_slot_idx ON buchungen (slot_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS buchungen_token_idx ON buchungen (token_hash)');
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

async function advisorId() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role='advisor' ORDER BY id LIMIT 1`);
  return rows[0] ? rows[0].id : null;
}

// ── Einstellungen ──
async function einstellungen(aid) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT daten FROM buchung_einstellungen WHERE advisor_id=$1', [aid]);
  let o = {};
  try { o = rows[0] ? JSON.parse(rows[0].daten) : {}; } catch { o = {}; }
  return B.einstellungen(o);
}
async function einstellungenSpeichern(aid, roh) {
  await ensureSchema();
  const s = B.einstellungen(roh);
  const j = JSON.stringify(s);
  const up = await pool.query('UPDATE buchung_einstellungen SET daten=$2 WHERE advisor_id=$1', [aid, j]);
  if (!up.rowCount) await pool.query('INSERT INTO buchung_einstellungen (advisor_id, daten) VALUES ($1,$2)', [aid, j]);
  cacheLeeren();
  return s;
}

// ── Freie Zeiten ──
// Quellen: eigene Einträge (Termine, Blöcke, Ferien, Feiertage), weitere Google-Kalender, fremde Kalender (ICS).
// Die Plan-Aufgaben des Tages sind verschiebbar und zählen nicht als besetzt.
async function freie(aid, s, jetzt, { ohneEintragId = null } = {}) {
  const eigene = (await D.eintraege(aid)).filter(e => e.id !== ohneEintragId);
  const heute = Z.heute(jetzt);
  const map = new Map();
  for (let i = 0; i <= s.horizont; i++) {
    const d = Z.addTage(heute, i);
    if (Z.wd(d) >= 6 || Z.feiertagName(d)) { map.set(d, { ganz: true, iv: [] }); continue; }
    const liste = T.eintraegeAm(eigene, d);
    const fremd = await D.fremdFuerTag(aid, d);
    const google = await D.googleFuerTag(aid, d);
    map.set(d, B.belegungAus(liste.concat(fremd.map(x => ({ ...x, fremd: true })), google.map(x => ({ ...x, fremd: true })))));
  }
  return B.freieZeiten({ jetzt, s, belegung: (d) => map.get(d) || { ganz: true, iv: [] } });
}

let cache = null;
function cacheLeeren() { cache = null; }
// Kurzer Zwischenspeicher für die öffentliche Liste (höchstens 20 Sekunden alt). Beim Buchen wird immer frisch gerechnet.
async function freieOeffentlich(aid, jetzt, zwischenspeicher = true) {
  if (zwischenspeicher && cache && cache.aid === aid && jetzt.getTime() - cache.t < 20000 && jetzt.getTime() >= cache.t) return cache.daten;
  const s = await einstellungen(aid);
  const daten = { aktiv: s.aktiv, dauer: s.dauer, tage: s.aktiv ? B.nachTagen(await freie(aid, s, jetzt)) : [] };
  cache = { aid, t: jetzt.getTime(), daten };
  return daten;
}

// ── Sperre ──
let kette = Promise.resolve();
async function mitSperre(fn) {
  const vorher = kette;
  let frei;
  kette = new Promise(r => { frei = r; });
  await vorher.catch(() => {});
  let client = null;
  try {
    if (typeof pool.connect === 'function') {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    }
    const r = await fn();
    if (client) await client.query('COMMIT');
    return r;
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client) client.release();
    frei();
  }
}

// ── Hilfen ──
function zeile(r) {
  if (!r) return null;
  return { id: r.id, advisor_id: r.advisor_id, name: r.name, email: r.email, anliegen: r.anliegen || '', datum: r.datum, beginn: r.beginn, ende: r.ende, status: r.status,
    start_at: new Date(r.start_at), eintrag_id: r.eintrag_id, inquiry_id: r.inquiry_id, ursprung_id: r.ursprung_id || r.id, version: r.version || 0, erinnert_am: r.erinnert_am, token_hash: r.token_hash };
}
async function nachId(id) { await ensureSchema(); const { rows } = await pool.query('SELECT * FROM buchungen WHERE id=$1', [id]); return zeile(rows[0]); }
async function nachToken(token) {
  await ensureSchema();
  if (!B.tokenForm(token)) return null;
  const { rows } = await pool.query('SELECT * FROM buchungen WHERE token_hash=$1 ORDER BY id DESC LIMIT 1', [B.tokenHash(token)]);
  return zeile(rows[0]);
}
const basisUrl = () => (process.env.BUCHUNG_BASIS_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const verwaltenUrl = (token) => `${basisUrl()}/termin#t=${token}`;
const neuUrl = () => `${basisUrl()}/termin`;

const syncEreignis = (e, aid) => ({ advisorId: aid, id: e.id, uid: `rq-e${e.id}@rhetoriq.ch`, titel: e.titel, datum: e.datum, beginn: e.beginn, ende: e.ende, ganztaegig: e.ganztaegig, typ: e.typ, notiz: e.notiz,
  wiederholung: e.wiederholung, wochentage: e.wochentage, bis: e.bis });
function syncSicher(methode, e, aid) {
  try { Promise.resolve(sync[methode](syncEreignis(e, aid))).catch(x => console.error('[buchung] Sync fehlgeschlagen:', x && x.message)); } catch (x) { console.error('[buchung] Sync fehlgeschlagen:', x && x.message); }
}
function mailSicher(m) {
  return Promise.resolve().then(() => queueEmail(m)).catch(e => console.error('[buchung] Mail fehlgeschlagen:', m.kind, e && e.message));
}
function anBeraterin(kind, m) {
  return Promise.all(advisorEmails().map(to => mailSicher({ kind, to, subject: m.subject, text: m.text, senderName: 'RhetorIQ' })));
}
const icsAnhang = (ics) => [{ name: 'gespraech.ics', contentBase64: Buffer.from(ics, 'utf8').toString('base64') }];
function icsFuer(b, s, token, jetzt, abgesagt = false) {
  return B.buchungIcs({ id: b.ursprung_id, datum: b.datum, beginn: b.beginn, ende: b.ende }, { jetzt, abgesagt, verwaltenUrl: token ? verwaltenUrl(token) : '', kontaktText: s.kontakt_text, kontaktLink: s.kontakt_link, version: b.version });
}
const bucheTitel = (name) => `Gespräch mit ${B.einZeile(name, 60)}`;
function terminText(b) { return `${Z.datumMitJahr(b.datum)}, ${Z.hhmm(b.beginn)} Uhr (Schweizer Zeit)`; }

// ── Buchen und Verschieben ──
// werte: geprüfte Eingaben (name, email, message, start, token). Gibt { ok, buchung, token, alt } oder { status, fehler } zurück.
async function buchen(aid, werte, { jetzt = new Date() } = {}) {
  await ensureSchema();
  let ergebnis;
  try {
    ergebnis = await mitSperre(async () => {
      const s = await einstellungen(aid);
      if (!s.aktiv) return { status: 403, fehler: 'Die Terminbuchung ist zurzeit nicht verfügbar. Bitte senden Sie mir eine Nachricht.' };
      let alt = null;
      if (werte.token) {
        alt = await nachToken(werte.token);
        if (!alt || alt.status !== 'gebucht') return { status: 404, fehler: 'Dieser Link ist nicht mehr gültig. Bitte wählen Sie einen neuen Termin.' };
        if (alt.start_at.getTime() <= jetzt.getTime()) return { status: 400, fehler: 'Dieser Termin liegt in der Vergangenheit und kann nicht mehr verschoben werden.' };
      }
      const name = alt ? alt.name : werte.name, email = alt ? alt.email : werte.email, anliegen = alt ? alt.anliegen : (werte.message || '');
      const liste = await freie(aid, s, jetzt, { ohneEintragId: alt ? alt.eintrag_id : null });
      const f = B.findeFenster(liste, werte.start);
      if (!f) return { status: 409, fehler: 'Dieser Termin ist leider gerade vergeben, bitte wählen Sie einen anderen.' };
      if (!alt) {
        const offen = await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE email=$1 AND status='gebucht' AND start_at > $2`, [email, jetzt]);
        if (offen.rows[0].n >= MAX_OFFEN) return { status: 429, fehler: 'Für diese E-Mail-Adresse bestehen bereits zwei offene Termine. Bitte sagen Sie einen davon ab oder schreiben Sie mir eine Nachricht.' };
        const heute = await pool.query(`SELECT COUNT(*)::int AS n FROM buchungen WHERE created_at > $1`, [new Date(jetzt.getTime() - 24 * 3600000)]);
        if (heute.rows[0].n >= TAGESLIMIT) return { status: 429, fehler: 'Heute sind leider keine weiteren Buchungen möglich. Bitte versuchen Sie es morgen noch einmal oder senden Sie mir eine Nachricht.' };
      }
      const token = alt ? werte.token : B.tokenNeu();
      const tokenH = B.tokenHash(token);
      const schluessel = `${aid}|${f.start.toISOString()}`;
      let neuId;
      try {
        const ins = await pool.query(
          `INSERT INTO buchungen (advisor_id, name, email, anliegen, start_at, ende_at, datum, beginn, ende, status, slot_key, token_hash, ursprung_id, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'gebucht',$10,$11,$12,$13) RETURNING id`,
          [aid, name, email, anliegen, f.start, f.ende, f.datum, f.beginn, f.beginn + s.dauer, schluessel, alt ? null : tokenH, alt ? alt.ursprung_id : null, alt ? alt.version + 1 : 0]);
        neuId = ins.rows[0].id;
      } catch (e) {
        if (e && (e.code === '23505' || /unique|duplicate/i.test(e.message || ''))) return { status: 409, fehler: 'Dieser Termin ist leider gerade vergeben, bitte wählen Sie einen anderen.' };
        throw e;
      }
      if (!alt) await pool.query('UPDATE buchungen SET ursprung_id=$1 WHERE id=$1', [neuId]);
      try {
        const p = T.eintragPruefen({ titel: bucheTitel(name), typ: 'kunde', datum: f.datum, beginn: Z.hhmm(f.beginn), ende: Z.hhmm(f.beginn + s.dauer),
          notiz: `Gebucht über die Webseite. E-Mail: ${email}.${anliegen ? ' Anliegen: ' + B.mehrzeilig(anliegen, 300).replace(/\n+/g, ' ') : ''}` }, { settings: await D.einstellungen(aid) });
        if (p.fehler) throw new Error(p.fehler);
        const eintrag = await D.eintragAnlegen(aid, p.eintrag);
        await pool.query('UPDATE buchungen SET eintrag_id=$2 WHERE id=$1', [neuId, eintrag.id]);
        // Anfrage in der bestehenden Tabelle: neue Buchung legt sie an, Verschieben ergänzt sie
        const inq = require('../routes/inquiries');
        await inq.ensureTable();
        let inquiryId = alt ? alt.inquiry_id : null;
        const hinweis = `Terminbuchung für ${terminText({ datum: f.datum, beginn: f.beginn })}.${anliegen ? '\n\nAnliegen: ' + anliegen : ''}`;
        if (alt && inquiryId) {
          await pool.query(`UPDATE inquiries SET message = COALESCE(message,'') || $2 WHERE id=$1`, [inquiryId, `\n\nTermin verschoben auf ${terminText({ datum: f.datum, beginn: f.beginn })}.`]);
        } else {
          const r = await pool.query(`INSERT INTO inquiries (name, email, message, source, ack_sent_at) VALUES ($1,$2,$3,'terminbuchung',NOW()) RETURNING id`, [name, email, hinweis]);
          inquiryId = r.rows[0].id;
        }
        await pool.query('UPDATE buchungen SET inquiry_id=$2 WHERE id=$1', [neuId, inquiryId]);
        if (alt) {
          await pool.query(`UPDATE buchungen SET status='verschoben', slot_key=NULL, token_hash=NULL, storniert_am=$2 WHERE id=$1`, [alt.id, jetzt]);
          await pool.query('UPDATE buchungen SET token_hash=$2 WHERE id=$1', [neuId, tokenH]);
          if (alt.eintrag_id) { const g = await D.eintragLoeschen(aid, alt.eintrag_id); if (g) syncSicher('delete', g, aid); }
        }
        const neu = await nachId(neuId);
        return { ok: true, buchung: neu, eintrag, token, alt, s };
      } catch (e) {
        await pool.query('DELETE FROM buchungen WHERE id=$1', [neuId]).catch(() => {});
        throw e;
      }
    });
  } catch (e) {
    console.error('[buchung] Buchung fehlgeschlagen:', e && e.message);
    return { status: 500, fehler: 'Die Buchung hat leider nicht geklappt. Bitte versuchen Sie es noch einmal oder senden Sie mir eine Nachricht.' };
  }
  if (!ergebnis.ok) return ergebnis;
  cacheLeeren();
  const { buchung: b, token, alt, s, eintrag } = ergebnis;
  syncSicher('push', eintrag, aid);
  const art = alt ? 'verschoben' : 'neu';
  const m = M.bestaetigung(b, s, { verwaltenUrl: verwaltenUrl(token), art });
  mailSicher({ kind: alt ? 'buchung_verschoben' : 'buchung_bestaetigung', to: b.email, subject: m.subject, text: m.text, senderName: 'Lorena Lienhard', attachments: icsAnhang(icsFuer(b, s, token, jetzt)) });
  const h = M.hinweisBeraterin({ ...b, anliegen: b.anliegen }, { art, alt });
  anBeraterin(alt ? 'buchung_verschoben_hinweis' : 'buchung_hinweis', h);
  return ergebnis;
}

// ── Absagen ──
// wer: 'interessent' oder 'beraterin'. b: Zeile aus nachToken oder nachId.
async function absagen(aid, id, { wer = 'interessent', jetzt = new Date() } = {}) {
  await ensureSchema();
  const erg = await mitSperre(async () => {
    const b = await nachId(id);
    if (!b) return { status: 404, fehler: 'Dieser Termin wurde nicht gefunden.' };
    if (b.status === 'abgesagt') return { ok: true, schon: true, buchung: b };
    if (b.status !== 'gebucht') return { status: 404, fehler: 'Dieser Link ist nicht mehr gültig.' };
    if (b.start_at.getTime() <= jetzt.getTime()) return { status: 400, fehler: 'Dieser Termin liegt in der Vergangenheit.' };
    const up = await pool.query(`UPDATE buchungen SET status='abgesagt', slot_key=NULL, storniert_am=$2, abgesagt_von=$3 WHERE id=$1 AND status='gebucht'`, [id, jetzt, wer]);
    if (!up.rowCount) return { ok: true, schon: true, buchung: b };
    let g = null;
    if (b.eintrag_id) g = await D.eintragLoeschen(aid, b.eintrag_id);
    if (b.inquiry_id) await pool.query(`UPDATE inquiries SET message = COALESCE(message,'') || $2 WHERE id=$1`, [b.inquiry_id, `\n\nTermin am ${terminText(b)} abgesagt (${wer === 'beraterin' ? 'durch Lorena' : 'durch die Person'}).`]).catch(() => {});
    return { ok: true, buchung: b, eintragWeg: g };
  });
  if (!erg.ok || erg.schon) return erg;
  cacheLeeren();
  if (erg.eintragWeg) syncSicher('delete', erg.eintragWeg, aid);
  const b = erg.buchung;
  const s = await einstellungen(aid);
  const a = M.absageInteressent(b, { neuUrl: neuUrl(), von: wer });
  mailSicher({ kind: 'buchung_abgesagt', to: b.email, subject: a.subject, text: a.text, senderName: 'Lorena Lienhard', attachments: icsAnhang(icsFuer(b, s, null, jetzt, true)) });
  anBeraterin('buchung_abgesagt_hinweis', M.absageBeraterin(b, { von: wer }));
  return erg;
}

// ── Listen ──
async function kommende(aid, jetzt = new Date()) {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT * FROM buchungen WHERE advisor_id=$1 AND status='gebucht' AND ende_at > $2 ORDER BY start_at`, [aid, jetzt]);
  return rows.map(r => {
    const b = zeile(r);
    return { id: b.id, name: b.name, email: b.email, anliegen: b.anliegen, datum: b.datum, beginn: Z.hhmm(b.beginn), ende: Z.hhmm(b.ende), text: terminText(b) };
  });
}

// ── Erinnerung am Vortag ──
// Idempotent: jede Buchung wird zuerst reserviert (erinnert_am), erst danach geht die Mail hinaus.
async function erinnerungenSenden({ jetzt = new Date() } = {}) {
  await ensureSchema();
  const morgen = Z.addTage(Z.heute(jetzt), 1);
  const { rows } = await pool.query(`SELECT * FROM buchungen WHERE status='gebucht' AND datum=$1 AND erinnert_am IS NULL ORDER BY start_at`, [morgen]);
  let n = 0;
  for (const r of rows) {
    const up = await pool.query(`UPDATE buchungen SET erinnert_am=$2 WHERE id=$1 AND erinnert_am IS NULL AND status='gebucht'`, [r.id, jetzt]);
    if (!up.rowCount) continue;
    const b = zeile(r);
    const s = await einstellungen(r.advisor_id);
    // Der Token ist nur als Hash gespeichert, die Erinnerung verweist deshalb auf den Link der Bestätigungsmail.
    const m = M.erinnerung(b, s);
    try { await queueEmail({ kind: 'buchung_erinnerung', to: b.email, subject: m.subject, text: m.text, senderName: 'Lorena Lienhard' }); n++; }
    catch (e) { console.error('[buchung] Erinnerung fehlgeschlagen:', e && e.message); }
  }
  return { status: 'ok', gesendet: n, kandidaten: rows.length };
}

module.exports = { ensureSchema, advisorId, einstellungen, einstellungenSpeichern, freie, freieOeffentlich, cacheLeeren, mitSperre, buchen, absagen, kommende, erinnerungenSenden,
  nachToken, nachId, verwaltenUrl, neuUrl, basisUrl, TAGESLIMIT, MAX_OFFEN };
