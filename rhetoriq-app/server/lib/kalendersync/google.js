// Anbieter «Google Kalender»: Google ist die Zentrale. RhetorIQ schreibt in einen eigenen Kalender «RhetorIQ» (Termine, Blöcke, Aufgaben des Tages)
// und liest Änderungen vom Handy zurück. Zwei Richtungen:
//  Schreiben: push/delete markieren nur, dass etwas zu tun ist. Nach einer kurzen Entprellung gleicht schreibenAbgleich() den Sollzustand
//             (60 Tage, Serien werden zu einzelnen Ereignissen ausgerollt: robuster, weil jede Änderung am Handy genau ein Ereignis trifft) mit der
//             Verknüpfungstabelle ab und sendet nur Unterschiede. Bei Fehlern folgt eine Wiederholung mit wachsendem Abstand.
//  Lesen:     lesenAbgleich() holt Änderungen inkrementell (syncToken, bei 410 vollständig neu) und wendet die Rückmeldungsregeln an.
// Echo-Schutz: eigene Schreibvorgänge speichern den ETag der Antwort. Kommt dasselbe Ereignis zurück, wird es übersprungen. Zusätzlich
// vergleicht ein Kernhash (Titel, Tag, Zeit) den Inhalt, damit nur echte Änderungen am Handy etwas auslösen.
const crypto = require('crypto');
const secretBox = require('../secretBox');
const KD = require('./daten');
const G = require('./googleApi');
const D = require('../tagesplanDaten');
const T = require('../tagesplan');
const Z = require('../zeit');
const { ohneStriche } = require('../ics');

const FENSTER_TAGE = 60;      // Sollzustand: gestern bis heute plus 60 Tage
const IMPORT_TAGE = 120;      // Termine vom Handy werden bis so weit in die Zukunft übernommen
const KANAL_VORLAUF_MS = 24 * 3600 * 1000;
const zeitgeber = { entprellung: 3000, wiederholung: [30000, 120000, 600000, 1800000], webhookEntprellung: 1500 };
function _setZeitgeber(o) { Object.assign(zeitgeber, o); }

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const PAKETFARBE = { enterprise: '#17407a', business: '#2f64ad', team: '#4a7fc4', stimme: '#7ea3d6' };

// ── Farben: nächstliegende Google-colorId ──
const GOOGLE_FARBEN = { 1: '#a4bdfc', 2: '#7ae7bf', 3: '#dbadff', 4: '#ff887c', 5: '#fbd75b', 6: '#ffb878', 7: '#46d6db', 8: '#e1e1e1', 9: '#5484ed', 10: '#51b749', 11: '#dc2127' };
function rgb(h) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null; }
function colorId(hex) {
  const c = rgb(hex);
  if (!c) return '9';
  let best = '9', bd = Infinity;
  for (const [id, f] of Object.entries(GOOGLE_FARBEN)) {
    const g = rgb(f);
    const d = (c[0] - g[0]) ** 2 + (c[1] - g[1]) ** 2 + (c[2] - g[2]) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

// ── Serialisierung pro Beraterin: Lesen und Schreiben nie gleichzeitig ──
const ketten = new Map();
function seriell(aid, fn) {
  const vorher = ketten.get(aid) || Promise.resolve();
  const p = vorher.catch(() => {}).then(fn);
  const ende = p.catch(() => {});
  ketten.set(aid, ende);
  ende.then(() => { if (ketten.get(aid) === ende) ketten.delete(aid); });
  return p;
}

// ── Sollzustand ──
const eventId = (uid) => 'rq' + sha(uid).slice(0, 40);
const uidEintrag = (id, datum) => `rq-e${id}-${datum}@rhetoriq.ch`;
const uidAufgabe = (key) => `rq-${key}@rhetoriq.ch`;
const lokalZeit = (datum, min) => (min >= 1440 ? `${Z.addTage(datum, 1)}T00:00:00` : `${datum}T${Z.hhmm(min)}:00`);
function kernHash(art, t) {
  return sha(JSON.stringify(art === 'task' ? { d: t.datum, b: t.beginn, e: t.ende } : { t: t.titel, d: t.datum, b: t.beginn, e: t.ende, g: !!t.ganztaegig }));
}
function koerper({ uid, art, titel, datum, beginn, ende, ganztaegig, beschreibung, farbe, url, eintragId, taskKey }) {
  const b = {
    summary: ohneStriche(titel).slice(0, 200) || 'Ohne Titel',
    description: ohneStriche(beschreibung || ''),
    colorId: colorId(farbe),
    status: 'confirmed',
    reminders: { useDefault: true },
    extendedProperties: { private: { rqHerkunft: 'rhetoriq', rqUid: uid, rqArt: art, ...(eintragId ? { rqEintrag: String(eintragId) } : {}), ...(taskKey ? { rqKey: taskKey } : {}) } }
  };
  if (ganztaegig) { b.start = { date: datum }; b.end = { date: Z.addTage(datum, 1) }; b.transparency = 'transparent'; }
  else { b.start = { dateTime: lokalZeit(datum, beginn), timeZone: 'Europe/Zurich' }; b.end = { dateTime: lokalZeit(datum, ende), timeZone: 'Europe/Zurich' }; b.transparency = 'opaque'; }
  if (url && /^https:\/\//i.test(url)) b.source = { title: 'RhetorIQ', url };
  return b;
}

// Was in Google stehen soll: Map uid -> { uid, art, body, hash, kern, ... }
async function sollzustand(aid, heute) {
  const von = Z.addTage(heute, -1), bis = Z.addTage(heute, FENSTER_TAGE);
  const s = await D.einstellungen(aid);
  const farbeVon = new Map(T.alleTypen(s).map(t => [t.key, t.farbe]));
  const soll = new Map();
  const eintraege = await D.eintraege(aid);
  for (let d = von; d <= bis; d = Z.addTage(d, 1)) {
    for (const e of T.eintraegeAm(eintraege, d)) {
      const uid = uidEintrag(e.id, d);
      const teile = { titel: ohneStriche(e.titel).slice(0, 200) || 'Ohne Titel', datum: d, beginn: e.beginn, ende: e.ende, ganztaegig: e.ganztaegig };
      const body = koerper({ uid, art: 'eintrag', titel: e.titel, datum: d, beginn: e.beginn, ende: e.ende, ganztaegig: e.ganztaegig, beschreibung: e.notiz, farbe: farbeVon.get(e.typ), eintragId: e.id });
      soll.set(uid, { uid, art: 'eintrag', eintragId: e.id, taskKey: null, datum: d, beginn: e.beginn, ende: e.ende, body, hash: sha(JSON.stringify(body)), kern: kernHash('eintrag', teile) });
    }
  }
  // Aufgaben: der Plan von heute, dazu von Hand auf spätere Tage gelegte Aufgaben
  const pos = await D.positionen(aid);
  const tage = new Set([heute]);
  for (const p of Object.values(pos)) if (p.datum > heute && p.datum <= bis) tage.add(p.datum);
  for (const d of [...tage].sort()) {
    const plan = await D.planFuer(aid, d);
    for (const i of plan.items) {
      if (d !== heute && !i.fixiert) continue;
      const uid = uidAufgabe(i.key);
      if (soll.has(uid)) continue;
      const farbe = (i.verspaetet || i.ueberfaellig) ? '#b3261e' : (PAKETFARBE[i.paket] || '#4a7fc4');
      const beschr = [i.klient ? `Klient: ${i.klient}` : '', i.textart ? `Textart: ${i.textart}` : '', i.fristText ? `Frist: ${i.fristText}` : '', i.link ? `Link: ${i.link}` : ''].filter(Boolean).join('\n');
      const body = koerper({ uid, art: 'task', titel: i.titel, datum: d, beginn: i.beginn, ende: i.ende, ganztaegig: false, beschreibung: beschr, farbe, url: i.link, taskKey: i.key });
      soll.set(uid, { uid, art: 'task', eintragId: null, taskKey: i.key, datum: d, beginn: i.beginn, ende: i.ende, body, hash: sha(JSON.stringify(body)), kern: kernHash('task', { datum: d, beginn: i.beginn, ende: i.ende }) });
    }
  }
  return { soll, von, eintraegeIds: new Set(eintraege.map(e => e.id)) };
}

// ── Schreiben ──
async function schreibenAbgleich(aid, { jetzt = new Date() } = {}) {
  const row = await KD.googleZeile(aid);
  if (!row || !row.calendar_id) return { eingefuegt: 0, geaendert: 0, geloescht: 0 };
  const cal = row.calendar_id;
  const heute = Z.heute(jetzt);
  const { soll, von, eintraegeIds } = await sollzustand(aid, heute);
  const maps = new Map((await KD.mapAlle(aid)).map(m => [m.uid, m]));
  const z = { eingefuegt: 0, geaendert: 0, geloescht: 0 };
  let ersterFehler = null, nachlesen = false;
  const merke = (e) => { if (!ersterFehler) ersterFehler = e; };

  for (const w of soll.values()) {
    const m = maps.get(w.uid);
    const speichern = (g, id) => KD.mapSetzen(aid, { uid: w.uid, google_id: id, art: w.art, eintrag_id: w.eintragId, task_key: w.taskKey, datum: w.datum, beginn: w.beginn, ende: w.ende,
      etag: g && g.etag ? g.etag : null, hash: w.hash, kern: w.kern, google_updated: g && g.updated ? g.updated : null });
    try {
      if (!m) {
        const id = eventId(w.uid);
        let r = await G.ereignisEinfuegen(aid, cal, { ...w.body, id });
        if (r.status === 409) { // gleiche ID gab es schon (zum Beispiel gelöscht): Ereignis wieder herstellen
          r = await G.ereignisErsetzen(aid, cal, id, { ...w.body, id });
          if (r.status === 404 || r.status === 410) throw new G.GoogleFehler('Ereignis konnte nicht angelegt werden.', { status: r.status });
        }
        await speichern(r.json, id);
        z.eingefuegt++;
      } else if (m.hash !== w.hash) {
        const r = await G.ereignisAendern(aid, cal, m.google_id, w.body);
        if (r.status === 404 || r.status === 410) { nachlesen = true; continue; } // am Handy gelöscht: erst lesen, dann entscheiden
        await speichern(r.json, m.google_id);
        z.geaendert++;
      }
    } catch (e) { merke(e); if (e.code === 'invalid_grant' || e.code === 'schluessel' || e.code === 'nicht_verbunden') break; }
  }
  if (!ersterFehler || !['invalid_grant', 'schluessel', 'nicht_verbunden'].includes(ersterFehler.code)) {
    for (const m of maps.values()) {
      if (soll.has(m.uid)) continue;
      const verwaist = m.art === 'eintrag' ? !eintraegeIds.has(m.eintrag_id) : false;
      const imFenster = (m.datum || '') >= (m.art === 'task' ? heute : von);
      if (!verwaist && !imFenster) {
        if (m.art === 'task' && m.datum && m.datum < Z.addTage(heute, -7)) await KD.mapLoeschen(aid, m.uid); // alte Aufgabenverknüpfung vergessen
        continue;
      }
      try {
        await G.ereignisLoeschen(aid, cal, m.google_id);
        await KD.mapLoeschen(aid, m.uid);
        z.geloescht++;
      } catch (e) { merke(e); }
    }
  }
  if (nachlesen) { try { await lesenAbgleich(aid, { jetzt }); } catch (e) { merke(e); } }
  if (ersterFehler) throw ersterFehler;
  return z;
}

// ── Lesen: Rückmeldungen vom Handy ──
function zerlege(g) {
  const s = g.start, e = g.end;
  if (!s) return null;
  if (s.date) {
    const bis = e && e.date ? Z.addTage(e.date, -1) : s.date;
    return { ganztaegig: true, datum: s.date, bisDatum: bis < s.date ? s.date : bis, beginn: null, ende: null };
  }
  if (!s.dateTime) return null;
  const a = Z.zurich(new Date(s.dateTime));
  if (Number.isNaN(new Date(s.dateTime).getTime())) return null;
  let ende = a.min + 30;
  if (e && e.dateTime) {
    const b = Z.zurich(new Date(e.dateTime));
    ende = b.datum > a.datum ? 1440 : b.min;
  }
  if (ende <= a.min) ende = Math.min(1440, a.min + 30);
  return { ganztaegig: false, datum: a.datum, bisDatum: a.datum, beginn: a.min, ende };
}
const updatedNeuer = (lokal, google) => !!lokal && !!google && new Date(lokal).getTime() > new Date(google).getTime();

async function eintragAusTeilen(aid, basis, teile, titel, notiz) {
  const s = await D.einstellungen(aid);
  return T.eintragPruefen({
    titel, typ: basis.typ || 'termin', datum: teile.datum, beginn: teile.ganztaegig ? null : Z.hhmm(teile.beginn), ende: teile.ganztaegig ? null : Z.hhmm(teile.ende),
    ganztaegig: teile.ganztaegig, wiederholung: basis.wiederholung || 'keine', wochentage: basis.wochentage || [], bis: basis.bis || null, notiz
  }, { settings: s, heute: Z.heute() });
}

async function geloeschtVonHandy(aid, m, g, ctx) {
  if (!m) return 'ignoriert';
  if (m.art === 'task') {
    await KD.ausblenden(aid, m.task_key, m.datum);
    await KD.mapLoeschen(aid, m.uid);
    ctx.geaendert++;
    return 'ausgeblendet';
  }
  const e = await D.eintragHole(aid, m.eintrag_id);
  if (!e) { await KD.mapLoeschen(aid, m.uid); return 'ignoriert'; }
  if (updatedNeuer(e.aktualisiert, g && g.updated)) { await KD.mapLoeschen(aid, m.uid); return 'lokal neuer'; } // wird beim nächsten Schreiben wieder angelegt
  if (e.wiederholung === 'keine') await D.eintragLoeschen(aid, e.id);
  else await D.eintragAusnahme(aid, e.id, m.datum);
  await KD.mapLoeschen(aid, m.uid);
  ctx.geaendert++;
  return 'geloescht';
}

// Die lokale Änderung ist neuer: Google wird beim nächsten Schreiben überschrieben (Hash leeren, ETag merken, damit nicht erneut gelesen wird)
async function lokalGewinnt(aid, m, g) {
  await KD.mapSetzen(aid, { ...m, hash: null, etag: g.etag, google_updated: g.updated });
  return 'lokal neuer';
}

async function ereignisVerarbeiten(aid, g, ctx) {
  if (!g || !g.id) return 'ignoriert';
  const m = await KD.mapNachGoogleId(aid, g.id);
  if (g.status === 'cancelled') return geloeschtVonHandy(aid, m, g, ctx);
  if (m && m.etag && m.etag === g.etag) return 'echo';
  const teile = zerlege(g);
  if (!teile) return 'ignoriert';
  const titel = ohneStriche(g.summary || '').slice(0, 80) || 'Ohne Titel';
  const notiz = ohneStriche(g.description || '').slice(0, 500);

  if (m) {
    const kern = kernHash(m.art, { titel: ohneStriche(g.summary || '').slice(0, 200) || 'Ohne Titel', ...teile });
    if (kern === m.kern) { await KD.mapSetzen(aid, { ...m, etag: g.etag, google_updated: g.updated }); return 'echo'; }
    if (m.art === 'task') {
      if (teile.ganztaegig) return 'ignoriert';
      const pos = (await D.positionen(aid))[m.task_key];
      if (pos && updatedNeuer(pos.geaendert, g.updated)) return lokalGewinnt(aid, m, g);
      await D.positionSetzen(aid, m.task_key, teile.datum, teile.beginn, Math.max(5, teile.ende - teile.beginn));
      await KD.mapSetzen(aid, { ...m, datum: teile.datum, beginn: teile.beginn, ende: teile.ende, etag: g.etag, kern, google_updated: g.updated });
      ctx.geaendert++;
      return 'verschoben';
    }
    const e = await D.eintragHole(aid, m.eintrag_id);
    if (!e) return 'ignoriert';
    if (updatedNeuer(e.aktualisiert, g.updated)) return lokalGewinnt(aid, m, g);
    const p = await eintragAusTeilen(aid, e, { ...teile }, titel, e.notiz);
    if (p.fehler) return 'ignoriert';
    let ziel;
    if (e.wiederholung === 'keine') {
      ziel = await D.eintragAendern(aid, e.id, { ...p.eintrag, wiederholung: 'keine', wochentage: [], bis: null });
    } else { // eine einzelne Wiederholung einer Serie: Serie lässt den Tag aus, daraus wird ein einzelner Termin
      await D.eintragAusnahme(aid, e.id, m.datum);
      const einzel = await eintragAusTeilen(aid, { typ: e.typ }, teile, titel, e.notiz);
      if (einzel.fehler) return 'ignoriert';
      ziel = await D.eintragAnlegen(aid, einzel.eintrag);
    }
    await KD.mapLoeschen(aid, m.uid);
    await KD.mapSetzen(aid, { uid: uidEintrag(ziel.id, teile.datum), google_id: g.id, art: 'eintrag', eintrag_id: ziel.id, task_key: null, datum: teile.datum, beginn: teile.beginn, ende: teile.ende,
      etag: g.etag, hash: null, kern, google_updated: g.updated });
    ctx.geaendert++;
    return 'geaendert';
  }

  // Neu am Handy angelegt: wird zu einem Termin (Typ Termin)
  const heute = Z.heute();
  if (teile.bisDatum < Z.addTage(heute, -1) || teile.datum > Z.addTage(heute, IMPORT_TAGE)) return 'ausserhalb';
  const mehrtaegig = teile.ganztaegig && teile.bisDatum > teile.datum;
  const p = await eintragAusTeilen(aid, mehrtaegig ? { wiederholung: 'taeglich', bis: teile.bisDatum } : {}, teile, titel, notiz);
  if (p.fehler) return 'ignoriert';
  const neu = await D.eintragAnlegen(aid, p.eintrag);
  ctx.geaendert++;
  if (mehrtaegig) { ctx.loeschen.push(g.id); return 'neu'; } // die Tage schreibt der nächste Abgleich einzeln, das Sammelereignis entfällt
  const kern = kernHash('eintrag', { titel: ohneStriche(g.summary || '').slice(0, 200) || 'Ohne Titel', ...teile });
  await KD.mapSetzen(aid, { uid: uidEintrag(neu.id, teile.datum), google_id: g.id, art: 'eintrag', eintrag_id: neu.id, task_key: null, datum: teile.datum, beginn: teile.beginn, ende: teile.ende,
    etag: g.etag, hash: null, kern, google_updated: g.updated }); // hash leer: der nächste Abgleich ergänzt Farbe und Herkunft
  return 'neu';
}

async function lesenAbgleich(aid, { voll = false } = {}) {
  const row = await KD.googleZeile(aid);
  if (!row || !row.calendar_id) return { geaendert: 0 };
  const cal = row.calendar_id;
  const ctx = { geaendert: 0, loeschen: [] };
  let token = voll ? null : row.sync_token;
  for (let runde = 0; runde < 2; runde++) {
    const gesehen = new Set();
    let seite = null, neuesToken = null, seiten = 0, abgebrochen = false, zuruecksetzen = false;
    do {
      const q = { singleEvents: 'true', maxResults: 250, ...(token ? { syncToken: token } : {}), ...(seite ? { pageToken: seite } : {}) };
      const r = await G.ereignisListe(aid, cal, q);
      if (r.status === 410) { zuruecksetzen = true; break; }
      const j = r.json || {};
      for (const g of j.items || []) { gesehen.add(g.id); await ereignisVerarbeiten(aid, g, ctx); }
      seite = j.nextPageToken || null;
      neuesToken = j.nextSyncToken || neuesToken;
      if (++seiten >= 12 && seite) { abgebrochen = true; break; }
    } while (seite);
    if (zuruecksetzen) { await KD.googleSetzen(aid, { sync_token: null }); token = null; continue; } // 410: volle Neusynchronisation
    if (!token && !abgebrochen) { // volle Synchronisation: was bei Google fehlt, wurde dort gelöscht
      const heute = Z.heute();
      for (const m of await KD.mapAlle(aid)) {
        if (!gesehen.has(m.google_id) && (m.datum || '') >= Z.addTage(heute, -1)) await geloeschtVonHandy(aid, m, { updated: null }, ctx);
      }
    }
    for (const gid of ctx.loeschen.splice(0)) await G.ereignisLoeschen(aid, cal, gid).catch(() => {});
    await KD.googleSetzen(aid, { sync_token: abgebrochen ? null : neuesToken, letzte_sync: new Date() });
    return { geaendert: ctx.geaendert };
  }
  return { geaendert: ctx.geaendert };
}

// ── Kanal (Push-Benachrichtigung), läuft höchstens 7 Tage ──
async function kanalSicherstellen(aid, { erneuern = false, jetzt = new Date() } = {}) {
  const row = await KD.googleZeile(aid);
  if (!row || !row.calendar_id) return { ok: false, grund: 'nicht verbunden' };
  if (!G.webhookMoeglich()) return { ok: false, grund: 'APP_URL ist nicht https' };
  const ablauf = row.channel_ablauf ? new Date(row.channel_ablauf).getTime() : 0;
  if (row.channel_id && ablauf > jetzt.getTime() + KANAL_VORLAUF_MS && !erneuern) return { ok: true, erneuert: false };
  const geheimnis = KD.zufall(32);
  const id = crypto.randomUUID();
  const r = await G.beobachten(aid, row.calendar_id, { id, type: 'web_hook', address: G.webhookUrl(), token: geheimnis, params: { ttl: '604800' } });
  const j = r.json || {};
  const bis = Number(j.expiration) ? new Date(Number(j.expiration)) : new Date(jetzt.getTime() + 7 * 24 * 3600 * 1000);
  await KD.googleSetzen(aid, { channel_id: id, channel_token_hash: sha(geheimnis), channel_resource: j.resourceId || null, channel_ablauf: bis });
  if (row.channel_id) await G.kanalStoppen(aid, { id: row.channel_id, resourceId: row.channel_resource }).catch(() => {});
  return { ok: true, erneuert: true, bis };
}

// ── Planung: Entprellung und Wiederholung ──
let laufend = 0;             // Zähler für Arbeit, die gerade läuft (auch zwischen zwei Wiederholungen)
const geplant = new Map();   // aid -> { timer, versuch }
const statistik = { laeufe: 0 };
function fehlerSpeichern(aid, e) {
  const msg = G.sauber(e && e.message ? e.message : 'Fehler');
  return KD.googleZeile(aid).then(row => row && KD.googleSetzen(aid, { fehler: msg, fehler_seit: row.fehler_seit || new Date() })).catch(() => {});
}
async function laufen(aid) {
  try {
    await seriell(aid, async () => { statistik.laeufe++; await schreibenAbgleich(aid); });
    const row = await KD.googleZeile(aid);
    if (row) await KD.googleSetzen(aid, { letzte_sync: new Date(), fehler: null, fehler_seit: null });
    return true;
  } catch (e) {
    await fehlerSpeichern(aid, e);
    return e;
  }
}
function einplanen(aid, wartezeit, versuch = 0) {
  const alt = geplant.get(aid);
  if (alt) clearTimeout(alt.timer);
  const timer = setTimeout(async () => {
    geplant.delete(aid);
    laufend++;
    try {
      const r = await laufen(aid);
      if (r !== true && !(r && ['invalid_grant', 'schluessel', 'nicht_verbunden'].includes(r.code)) && versuch < zeitgeber.wiederholung.length) {
        einplanen(aid, zeitgeber.wiederholung[versuch], versuch + 1);
      }
    } finally { laufend--; }
  }, wartezeit);
  if (timer.unref) timer.unref();
  geplant.set(aid, { timer, versuch });
}
function abbrechenGeplant(aid) { const a = geplant.get(aid); if (a) { clearTimeout(a.timer); geplant.delete(aid); } }

const webhookGeplant = new Map();
function lesenEinplanen(aid) {
  if (webhookGeplant.has(aid)) return;
  const t = setTimeout(async () => {
    webhookGeplant.delete(aid);
    laufend++;
    try {
      await seriell(aid, async () => { await lesenAbgleich(aid); await schreibenAbgleich(aid); });
      await KD.googleSetzen(aid, { letzte_sync: new Date(), fehler: null, fehler_seit: null });
    } catch (e) { await fehlerSpeichern(aid, e); } finally { laufend--; }
  }, zeitgeber.webhookEntprellung);
  if (t.unref) t.unref();
  webhookGeplant.set(aid, t);
}
// Wartet, bis keine geplante oder laufende Arbeit mehr aussteht (für Tests und sauberes Beenden)
async function _ruhe() {
  for (let i = 0; i < 400; i++) {
    if (!geplant.size && !webhookGeplant.size && !ketten.size && !laufend) return;
    await new Promise(r => setTimeout(r, 10));
  }
}

async function ziele(ereignis) {
  if (ereignis && ereignis.advisorId) return KD.googleZeile(ereignis.advisorId).then(r => (r ? [r.advisor_id] : []));
  return (await KD.googleAlle()).map(r => r.advisor_id);
}

// ── Gesamtlauf: lesen, dann schreiben (Knopf, Kalenderseite öffnen, Job alle 15 Minuten) ──
async function synchronisiere(aid, { voll = false, kanal = true } = {}) {
  let r = { geaendert: 0 };
  try {
    await seriell(aid, async () => {
      r = await lesenAbgleich(aid, { voll });
      await schreibenAbgleich(aid);
    });
    await KD.googleSetzen(aid, { letzte_sync: new Date(), fehler: null, fehler_seit: null });
  } catch (e) {
    await fehlerSpeichern(aid, e);
    return { ok: false, fehler: G.sauber(e.message), code: e.code || '', geaendert: r.geaendert };
  }
  if (kanal) { try { await kanalSicherstellen(aid); } catch (e) { /* ohne Kanal sorgt der Takt von 15 Minuten für den Abgleich */ } }
  return { ok: true, geaendert: r.geaendert };
}

// ── Verbinden und Trennen ──
async function verbindungHerstellen(aid, code, verifier) {
  if (!secretBox.available()) { const e = new Error('Die Verschlüsselung ist nicht eingerichtet. Es wurde nichts gespeichert.'); e.code = 'NO_SECRET'; throw e; }
  const tok = await G.codeTauschen(code, verifier);
  if (!tok.refresh_token) throw new G.GoogleFehler('Google hat keinen Dauerzugriff erteilt. Bitte verbinde noch einmal und bestätige den Zugriff.', { code: 'kein_refresh' });
  if (!String(tok.scope || '').split(/\s+/).includes(G.SCOPE)) throw new G.GoogleFehler('Google hat den Zugriff auf den Kalender nicht erteilt.', { code: 'scope' });
  const alt = await KD.googleZeile(aid);
  await KD.googleVerbinden(aid, secretBox.encrypt(tok.refresh_token), alt ? alt.calendar_id : null);
  G.tokenVergessen(aid);
  let calId = alt && alt.calendar_id;
  if (calId) { const p = await G.kalenderPruefen(aid, calId); if (p.status !== 200) calId = null; }
  if (!calId) {
    const k = await G.kalenderAnlegen(aid);
    calId = k && k.id;
    if (!calId) throw new G.GoogleFehler('Der Kalender «RhetorIQ» konnte nicht angelegt werden.', { code: 'kalender' });
    await KD.googleSetzen(aid, { calendar_id: calId });
    await KD.mapAlle(aid).then(ms => Promise.all(ms.map(m => KD.mapLoeschen(aid, m.uid))));
  }
  return { calendarId: calId };
}

async function trennen(aid) {
  const row = await KD.googleZeile(aid);
  abbrechenGeplant(aid);
  let widerrufen = false;
  if (row) {
    if (row.channel_id) { try { await G.kanalStoppen(aid, { id: row.channel_id, resourceId: row.channel_resource }); } catch { /* egal */ } }
    try { widerrufen = await G.widerrufen(secretBox.decrypt(row.refresh_enc)); } catch { widerrufen = false; }
  }
  G.tokenVergessen(aid);
  await KD.googleLoeschen(aid);
  return { widerrufen };
}

// ── Webhook: Prüfung von Kanal-ID und Kanal-Token ──
async function webhookPruefen(kanalId, token) {
  const row = await KD.kanalZuId(kanalId);
  if (!row || typeof token !== 'string' || !token || !row.channel_token_hash) return null;
  const a = Buffer.from(sha(token)), b = Buffer.from(row.channel_token_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

// ── Anbieter-Schnittstelle der Sync-Schicht ──
module.exports = {
  name: 'google',
  async push(ereignis) { for (const aid of await ziele(ereignis)) einplanen(aid, zeitgeber.entprellung); },
  async delete(ereignis) { for (const aid of await ziele(ereignis)) einplanen(aid, zeitgeber.entprellung); },
  synchronisiere, schreibenAbgleich, lesenAbgleich, kanalSicherstellen, verbindungHerstellen, trennen, webhookPruefen, lesenEinplanen,
  colorId, eventId, sollzustand, uidEintrag, uidAufgabe, statistik, _setZeitgeber, _ruhe, einplanen
};
