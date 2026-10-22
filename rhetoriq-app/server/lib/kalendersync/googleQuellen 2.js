// Weitere Google-Kalender des Kontos (Hauptkalender, Einladungen, Abonnements): Google nach RhetorIQ, schreibgeschützt.
// Hier gibt es keinen einzigen Schreibaufruf an Google. Gelesen wird mit dem Scope calendar.readonly.
// Pro Kalender: erster Abgleich 60 Tage zurück bis 180 Tage voraus (events.list mit singleEvents), danach inkrementell mit syncToken,
// bei 410 vollständig neu. Ein Push-Kanal pro Kalender (events.watch) meldet Änderungen. Der Kalender «RhetorIQ» selbst gehört nicht dazu.
// Datenschutz: gespeichert werden Titel, Ort, Zeiten, Link und die Anzahl der Teilnehmenden. Keine Teilnehmerlisten, keine Beschreibungen.
// Die Google-Antwort wird mit «fields» auf diese Felder beschränkt. Nichts davon gelangt in Logs.
const crypto = require('crypto');
const KD = require('./daten');
const G = require('./googleApi');
const Z = require('../zeit');

const ZURUECK_TAGE = 60;
const VORAUS_TAGE = 180;
const ERNEUERN_AB_TAGE = 150;   // Fenster wird neu gelesen, wenn es weniger weit in die Zukunft reicht
const KANAL_VORLAUF_MS = 24 * 3600 * 1000;
const FELDER = 'nextPageToken,nextSyncToken,items(id,status,summary,location,htmlLink,start,end,transparency,eventType,attendees(self,responseStatus))';
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const FARBE = /^#[0-9a-fA-F]{6}$/;

const bereinigt = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Hat die gespeicherte Verbindung den Lesezugriff auf alle Kalender?
const lesenErlaubt = (row) => !!(row && G.hatLesen(row.scopes));

// ── Termin aus einem Google-Ereignis ──
function zeitenAus(g) {
  const s = g.start || {}, e = g.end || {};
  if (s.date) {
    if (!Z.istDatum(s.date)) return null;
    const endEx = Z.istDatum(e.date) ? e.date : Z.addTage(s.date, 1);
    let bis = Z.addTage(endEx, -1);
    if (bis < s.date) bis = s.date;
    return { ganztaegig: true, datum_von: s.date, datum_bis: bis, beginn_min: null, ende_min: null };
  }
  if (typeof s.dateTime !== 'string') return null;
  const lokal = (t) => { // mit Offset: exakt umrechnen. Ohne Offset gilt die Zeit als Zürcher Ortszeit.
    if (/(Z|[+-]\d\d:?\d\d)$/i.test(t)) { const d = new Date(t); return isNaN(d) ? null : Z.zurich(d); }
    const m = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)/.exec(t);
    return m && Z.istDatum(m[1]) ? { datum: m[1], min: Number(m[2]) * 60 + Number(m[3]) } : null;
  };
  const a = lokal(s.dateTime);
  if (!a) return null;
  let b = typeof e.dateTime === 'string' ? lokal(e.dateTime) : null;
  if (!b || b.datum < a.datum || (b.datum === a.datum && b.min <= a.min)) b = { datum: a.datum, min: Math.min(1440, a.min + 1) };
  let bis = b.datum, ende = b.min;
  if (b.min === 0 && b.datum > a.datum) { bis = Z.addTage(b.datum, -1); ende = 1440; } // endet um Mitternacht: gehört noch zum Vortag
  return { ganztaegig: false, datum_von: a.datum, datum_bis: bis, beginn_min: a.min, ende_min: ende };
}
// Liefert null (ignorieren), 'loeschen' (abgesagt, abgelehnt oder unbrauchbar) oder die Zeile für die Datenbank.
function terminAus(g) {
  if (!g || typeof g.id !== 'string' || !g.id) return null;
  if (g.status === 'cancelled') return 'loeschen';
  if (g.eventType === 'workingLocation') return 'loeschen';
  const att = Array.isArray(g.attendees) ? g.attendees : [];
  if (att.some(a => a && a.self && a.responseStatus === 'declined')) return 'loeschen'; // von Lorena abgelehnt
  const z = zeitenAus(g);
  if (!z) return 'loeschen';
  const link = typeof g.htmlLink === 'string' && /^https:\/\/(www\.)?google\.com\//i.test(g.htmlLink) ? g.htmlLink.slice(0, 500) : null;
  return {
    google_id: g.id, titel: bereinigt(g.summary, 200) || 'Ohne Titel', ort: bereinigt(g.location, 200) || null, link,
    teilnehmer: att.length, frei: g.transparency === 'transparent', ...z
  };
}

// ── Kalenderliste ──
// Gleicht die Auswahl mit der Kalenderliste des Kontos ab. Neue Kalender: nur der Hauptkalender ist angehakt. Die Farbe kommt von Google und ist änderbar.
async function listeAbgleichen(aid) {
  const row = await KD.googleZeile(aid);
  if (!row || !row.calendar_id || !lesenErlaubt(row)) return [];
  const liste = (await G.kalenderListe(aid)).filter(k => k && typeof k.id === 'string' && k.id && k.id !== row.calendar_id && !k.deleted);
  const vorhanden = new Map((await KD.quellenAlle(aid)).map(q => [q.calendar_id, q]));
  const gesehen = new Set();
  for (const k of liste) {
    gesehen.add(k.id);
    const name = bereinigt(k.summaryOverride || k.summary, 120) || 'Kalender';
    const q = vorhanden.get(k.id);
    if (q) { if (q.name !== name || (!!k.primary) !== !!q.primaer) await KD.quelleSetzen(q.id, { name, primaer: !!k.primary }); }
    else await KD.quelleAnlegen(aid, k.id, name, FARBE.test(String(k.backgroundColor || '')) ? k.backgroundColor : '#8a8f98', !!k.primary);
  }
  for (const q of vorhanden.values()) if (!gesehen.has(q.calendar_id)) await abschalten(aid, q, { entfernen: true });
  return KD.quellenAlle(aid);
}

// ── Lesen ──
const zurichStart = (datum) => Z.zuDate(datum, 0).toISOString();
async function quelleLesen(aid, q, { voll = false } = {}) {
  const heute = Z.heute();
  const fensterAlt = !q.fenster_bis || q.fenster_bis < Z.addTage(heute, ERNEUERN_AB_TAGE);
  let token = voll || fensterAlt ? null : q.sync_token;
  let geaendert = 0;
  for (let runde = 0; runde < 2; runde++) {
    const behalten = new Set();
    let seite = null, neuesToken = null, seiten = 0, zuruecksetzen = false;
    do {
      const query = { singleEvents: 'true', maxResults: 250, fields: FELDER, ...(seite ? { pageToken: seite } : {}),
        ...(token ? { syncToken: token } : { timeMin: zurichStart(Z.addTage(heute, -ZURUECK_TAGE)), timeMax: zurichStart(Z.addTage(heute, VORAUS_TAGE + 1)) }) };
      const r = await G.ereignisListe(aid, q.calendar_id, query);
      if (r.status === 410) { zuruecksetzen = true; break; }
      const j = r.json || {};
      for (const g of j.items || []) {
        const t = terminAus(g);
        if (t === 'loeschen') { await KD.terminLoeschen(aid, q.id, g.id); geaendert++; continue; }
        if (!t) continue;
        behalten.add(t.google_id);
        await KD.terminSetzen(aid, q.id, t);
        geaendert++;
      }
      seite = j.nextPageToken || null;
      neuesToken = j.nextSyncToken || neuesToken;
      if (++seiten > 40) throw new G.GoogleFehler('Der Kalender enthält zu viele Termine.', { code: 'zu_gross' });
    } while (seite);
    if (zuruecksetzen) { await KD.quelleSetzen(q.id, { sync_token: null, fenster_bis: null }); token = null; continue; } // 410: volle Neusynchronisation
    if (!token) { // volle Synchronisation: was Google nicht mehr nennt, ist weg
      for (const gid of await KD.termineIds(aid, q.id)) if (!behalten.has(gid)) { await KD.terminLoeschen(aid, q.id, gid); geaendert++; }
    }
    await KD.quelleSetzen(q.id, {
      sync_token: neuesToken, letzte_sync: new Date(), fehler: null, fehler_seit: null,
      ...(token ? {} : { fenster_bis: Z.addTage(heute, VORAUS_TAGE) })
    });
    return { geaendert };
  }
  return { geaendert };
}

// Alle aktiven Kalender lesen. Fehler werden pro Kalender festgehalten, die übrigen laufen weiter.
async function alleLesen(aid, { voll = false, nurId = null } = {}) {
  const row = await KD.googleZeile(aid);
  if (!row || !row.calendar_id || !lesenErlaubt(row)) return { geaendert: 0, fehler: 0 };
  let geaendert = 0, fehler = 0;
  for (const q of await KD.quellenAlle(aid)) {
    if (!q.aktiv || (nurId != null && q.id !== nurId)) continue;
    try { geaendert += (await quelleLesen(aid, q, { voll })).geaendert; }
    catch (e) {
      if (e && e.status === 404) { await abschalten(aid, q, { entfernen: true }); geaendert++; continue; } // Kalender existiert nicht mehr
      fehler++;
      await KD.quelleSetzen(q.id, { fehler: G.sauber(e && e.message ? e.message : 'Fehler'), fehler_seit: q.fehler_seit || new Date() }).catch(() => {});
    }
  }
  await KD.termineVorDatumLoeschen(aid, Z.addTage(Z.heute(), -(ZURUECK_TAGE + 1)));
  return { geaendert, fehler };
}

// ── Kanäle ──
async function kanalStoppen(aid, q) {
  if (q.channel_id) { try { await G.kanalStoppen(aid, { id: q.channel_id, resourceId: q.channel_resource }); } catch { /* egal */ } }
}
async function kanalSicherstellen(aid, q, { erneuern = false, jetzt = new Date() } = {}) {
  if (!G.webhookMoeglich()) return { ok: false, erneuert: false };
  const ablauf = q.channel_ablauf ? new Date(q.channel_ablauf).getTime() : 0;
  if (q.channel_id && ablauf > jetzt.getTime() + KANAL_VORLAUF_MS && !erneuern) return { ok: true, erneuert: false };
  const geheimnis = KD.zufall(32);
  const id = crypto.randomUUID();
  const r = await G.beobachten(aid, q.calendar_id, { id, type: 'web_hook', address: G.webhookUrl(), token: geheimnis, params: { ttl: '604800' } });
  const j = r.json || {};
  const bis = Number(j.expiration) ? new Date(Number(j.expiration)) : new Date(jetzt.getTime() + 7 * 24 * 3600 * 1000);
  await KD.quelleSetzen(q.id, { channel_id: id, channel_token_hash: sha(geheimnis), channel_resource: j.resourceId || null, channel_ablauf: bis });
  await kanalStoppen(aid, q);
  return { ok: true, erneuert: true, bis };
}
async function alleKanaele(aid, opts = {}) {
  const row = await KD.googleZeile(aid);
  if (!row || !lesenErlaubt(row)) return { erneuert: 0, fehler: 0 };
  let erneuert = 0, fehler = 0;
  for (const q of await KD.quellenAlle(aid)) {
    if (!q.aktiv) continue;
    try { const k = await kanalSicherstellen(aid, q, opts); if (k.erneuert) erneuert++; } catch { fehler++; }
  }
  return { erneuert, fehler };
}

// Kalender abwählen oder entfernen: Kanal beenden, Termine löschen
async function abschalten(aid, q, { entfernen = false } = {}) {
  await kanalStoppen(aid, q);
  if (entfernen) { await KD.quelleLoeschen(aid, q.id); return; }
  await KD.termineLoeschenQuelle(aid, q.id);
  await KD.quelleSetzen(q.id, { aktiv: false, sync_token: null, fenster_bis: null, channel_id: null, channel_token_hash: null, channel_resource: null, channel_ablauf: null, fehler: null, fehler_seit: null });
}
// Beim Trennen: alle Kanäle der weiteren Kalender beenden (die Datenbankzeilen löscht KD.googleLoeschen)
async function kanaeleBeenden(aid) {
  for (const q of await KD.quellenAlle(aid)) await kanalStoppen(aid, q);
}
// Nach einer neuen Verbindung ohne Lesezugriff bleiben keine Daten aus den übrigen Kalendern zurück
async function ohneLesenBereinigen(aid) {
  for (const q of await KD.quellenAlle(aid)) await kanalStoppen(aid, q);
  await KD.quellenLoeschenAlle(aid);
}

// Webhook: Kanal-ID und Kanal-Token einer weiteren Kalenderquelle prüfen
async function webhookPruefen(kanalId, token) {
  const q = await KD.quelleKanalZuId(kanalId);
  if (!q || typeof token !== 'string' || !token || !q.channel_token_hash) return null;
  const a = Buffer.from(sha(token)), b = Buffer.from(q.channel_token_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return q;
}

module.exports = {
  lesenErlaubt, terminAus, zeitenAus, listeAbgleichen, quelleLesen, alleLesen, kanalSicherstellen, alleKanaele, abschalten, kanaeleBeenden, ohneLesenBereinigen, webhookPruefen,
  ZURUECK_TAGE, VORAUS_TAGE
};
