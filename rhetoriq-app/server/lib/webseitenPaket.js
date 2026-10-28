// Batch-Generator «Seitenpaket»: erzeugt für ein Restaurant (Tabelle einheiten) mehrere Webseitentexte in einem Lauf.
// Der Lauf geschieht im Hintergrund des Servers, Seite für Seite (höchstens 2 gleichzeitig). Nach jeder Seite wird die Zeile
// in webseiten_pakete aktualisiert. Fakten, «Auf einen Blick» und JSON-LD kommen immer deterministisch aus dem Faktenblatt
// (lib/einheitFakten.js), nie aus der KI. Die Texte erscheinen zusätzlich im Verlauf (Tabelle analyses, Modul text-gen).
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const EF = require('./einheitFakten');
const GS = require('./gastroSeitentypen');
const WC = require('./webseitenCheck');
const SI = require('./seiteImport');

const PARALLEL = 2;
const MAX_SEITEN = 30;
const STICHWORT_MAX = 1500;
const IMPORT_TEXT_MAX = 12000;
const URL_MAX = 500;
const MODUL = 'text-gen';
const TEXTART_KEY = 'text-gen-website';

// Abrufroutinen für bestehende Seiten. Tests ersetzen diese Einträge, damit kein Netzzugriff nötig ist.
const abruf = {
  seiteLesen: (url, opt) => SI.seiteLesen(url, opt),
  sitemapSeiten: (url, opt) => SI.sitemapSeiten(url, opt)
};

// Pakete, die in diesem Prozess gerade laufen (Nummer -> true)
const laufende = new Set();

const parseJson = (j, fallback) => { try { const o = j ? JSON.parse(j) : fallback; return o == null ? fallback : o; } catch { return fallback; } };
const leer = () => ({ aufEinenBlick: [], jsonld: '', qualitaet: { ok: true, hinweise: [], luecken: [] } });

// Schweizer Schreibweise und keine Gedankenstriche in dem, was wir selbst bauen
const ohneStriche = s => String(s == null ? '' : s).replace(/\s*[–—]\s*/g, ', ');

// ---------- Auswahl und Prüfung der Anfrage ----------

// Seitentypen aus Body: explizite Liste, sonst Seitensatz. Liefert { typen } oder { fehler }
function waehleTypen(body) {
  const b = body || {};
  let typen;
  if (Array.isArray(b.seitentypen) && b.seitentypen.length) typen = b.seitentypen;
  else if (typeof b.seitensatz === 'string' && b.seitensatz) {
    typen = GS.SEITENSAETZE[b.seitensatz];
    if (!typen) return { fehler: 'Unbekannter Seitensatz.' };
  } else return { fehler: 'Bitte einen Seitensatz oder mindestens einen Seitentyp wählen.' };
  const sauber = [];
  for (const t of typen) {
    if (typeof t !== 'string' || !GS.SEITENTYPEN[t]) return { fehler: 'Unbekannter Seitentyp: ' + String(t).slice(0, 60) };
    if (!sauber.includes(t)) sauber.push(t);
  }
  if (sauber.length > MAX_SEITEN) return { fehler: 'Höchstens ' + MAX_SEITEN + ' Seiten pro Paket.' };
  return { typen: sauber };
}

function stichworteAus(body, typen) {
  const out = {};
  const s = body && body.stichworte;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    for (const k of typen) if (typeof s[k] === 'string' && s[k].trim()) out[k] = s[k].trim().slice(0, STICHWORT_MAX);
  }
  return out;
}

// Liefert { urls } oder { fehler }
function importUrlsAus(body, typen) {
  const out = {};
  const u = body && body.importUrls;
  if (u == null) return { urls: out };
  if (typeof u !== 'object' || Array.isArray(u)) return { fehler: 'importUrls muss ein Objekt sein.' };
  for (const k of typen) {
    if (u[k] == null || u[k] === '') continue;
    const s = String(u[k]).trim();
    let ok = false;
    try { const p = new URL(s); ok = (p.protocol === 'http:' || p.protocol === 'https:') && s.length <= URL_MAX; } catch { ok = false; }
    if (!ok) return { fehler: 'Ungültige Adresse für ' + k + '. Sie muss mit https:// beginnen.' };
    out[k] = s;
  }
  return { urls: out };
}

// Kontingent für `gesamt` Seiten prüfen. Liefert null (alles gut) oder { status, body } wie bei der normalen Erzeugung.
async function kontingentPruefen(clientId, advisor, gesamt) {
  const analyze = require('../routes/analyze');
  const quota = await analyze._internal.checkQuota(clientId, { advisor });
  if (!quota.ok) {
    if (quota.abo) return { status: 402, body: require('./abo').antwort402(quota.abo, clientId) };
    return { status: 429, body: { error: 'Monatliches Nutzungskontingent erreicht. Bitte kontaktieren Sie Ihre Beraterin für eine Erweiterung.', quotaExceeded: true, used: quota.used, limit: quota.limit, clientId } };
  }
  if (quota.limit) {
    const bedarf = gesamt * require('./abo').TOKENS_PRO_TEXT;
    if (quota.used + bedarf > quota.limit) {
      return { status: 429, body: { error: 'Monatliches Nutzungskontingent reicht für ' + gesamt + ' Seiten nicht aus. Bitte kontaktieren Sie Ihre Beraterin für eine Erweiterung.', quotaExceeded: true, used: quota.used, limit: quota.limit, clientId } };
    }
  }
  return null;
}

// ---------- Bausteine für den KI-Auftrag ----------

// Systemblöcke wie bei der normalen Erzeugung: Brand Voice des Kunden, Betrieb (Stimme und Fakten), globale Stilregeln
async function systemFuer(clientId, einheitId) {
  const analyze = require('../routes/analyze');
  const { sanitizeForPrompt, assembleSystemBlocks, einheitBlock } = analyze._internal;
  const AS = require('./arbeitssprache');
  const spracheZeile = await AS.zeile(pool, clientId);
  const sprache = AS.ausgabeSprache(null, spracheZeile);
  const RG = AS.regeln(sprache);
  const { fence } = require('./dataFence');
  const baseSystemDe = 'Du schreibst Webseitentexte für ein Restaurant: Suchmaschinen-tauglich, konkret, aus Gästesicht, in der Stimme des Betriebs. '
    + 'Fakten (Adresse, Zeiten, Preise, Telefon, Links) stammen ausschliesslich aus den Angaben des Auftrags. Du erfindest nichts und schreibst den Block «Auf einen Blick» nicht selbst. '
    + 'Antworte nur im verlangten Ausgabeformat, ohne Vorrede und ohne Erklärung.';
  const baseSystem = sprache === 'en'
    ? 'You write website copy for a restaurant in British English: search-engine friendly, concrete, from the guest\'s point of view, in the voice of the venue. '
      + 'Facts (address, hours, prices, telephone, links) come exclusively from the details of the request. You invent nothing and you do not write the block "At a glance" yourself. '
      + 'Answer only in the requested output format, without preamble and without explanation.'
    : baseSystemDe;
  let brandVoiceBlock = '';
  let hat = false;
  const { rows } = await pool.query(`SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY updated_at DESC`, [clientId]).catch(() => ({ rows: [] }));
  if (rows.length) {
    hat = true;
    brandVoiceBlock += RG.head;
    const auswahl = require('./brandVoiceAuswahl');
    rows.forEach(m => { brandVoiceBlock += `${m.memory_type.toUpperCase()}:\n${fence(m.memory_type, sanitizeForPrompt(auswahl.fuerAuftrag(m.content, 'website')))}\n\n`; });
    brandVoiceBlock += RG.tail;
  }
  brandVoiceBlock += await einheitBlock(clientId, einheitId, sprache);
  return { blocks: assembleSystemBlocks({ baseSystem, brandVoiceBlock, structuralRefBlock: '', geoBlock: '', restDynamicSystem: '', sprache }), hatBrandVoice: hat, sprache };
}

// Eine Seite als lesbarer Text für den Verlauf (analyses.result)
function seiteAlsText(s) {
  const L = [];
  if (s.titel) L.push('Titel: ' + s.titel);
  if (s.beschreibung) L.push('Beschreibung: ' + s.beschreibung);
  if (s.h1) L.push('H1: ' + s.h1);
  L.push('', s.text || '');
  if (s.faq && s.faq.length) {
    L.push('', 'FAQ');
    s.faq.forEach(f => L.push('', 'F: ' + f.frage, 'A: ' + f.antwort));
  }
  return L.join('\n').trim();
}

// ---------- Eine Seite erzeugen ----------

async function seiteErzeugen(job, typKey, i) {
  const ai = require('./aiProvider');
  const { sanitizeForPrompt } = require('../routes/analyze')._internal;
  const typ = GS.SEITENTYPEN[typKey];
  const e = job.einheit, fakten = job.fakten;

  let bestehenderText = '';
  if (job.importUrls[typKey]) {
    const alt = await abruf.seiteLesen(job.importUrls[typKey]);
    bestehenderText = sanitizeForPrompt(String((alt && alt.text) || '')).slice(0, IMPORT_TEXT_MAX);
    if (!bestehenderText.trim()) throw new Error('Auf der angegebenen Seite wurde kein Text gefunden.');
  }
  const userMsg = GS.promptFuer(typKey, {
    restaurantName: e.name,
    ort: fakten.ort || e.ort || '',
    kueche: fakten.kueche || '',
    sprache: job.system.sprache === 'en' ? 'English' : undefined,
    faktenText: EF.faktenText(e, fakten, { sprache: job.system.sprache }),
    aufEinenBlickZeilen: EF.aufEinenBlick(e, fakten, { sprache: job.system.sprache }).map(z => z.label + ': ' + z.wert),
    stichworte: job.stichworte[typKey] ? sanitizeForPrompt(job.stichworte[typKey]) : '',
    bestehenderText
  });

  const temp = require('./temperaturen').temperaturFor(MODUL);
  const resp = await ai.generateText({
    system: job.system.blocks,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: 4000,
    model: ai.resolveModelId('sonnet'),
    temperature: temp,
    meter: { module: MODUL, advisorId: job.advisorId, clientId: job.clientId }
  });
  const roh = String((resp && resp.text) || '').trim();
  if (!roh) throw new Error('Die KI hat keinen Text geliefert.');
  const p = GS.parseAusgabe(roh);
  if (!p.text && !p.h1) throw new Error('Die Antwort der KI hatte nicht das erwartete Format.');

  // Fakten, Auf einen Blick und JSON-LD kommen nie aus der KI
  const seite = { titel: p.titel, beschreibung: p.beschreibung, h1: p.h1, h2: p.h2, text: p.text, faq: p.faq.filter(f => f.frage && f.antwort) };
  const q = WC.seitenQualitaet(seite, { sprache: job.system.sprache, ziel: { laengeWoerter: typ.laengeWoerter, faqNoetig: typ.faqFragen.length > 0 } });
  const konflikte = WC.faktenKonflikte([{ ...seite, id: typKey, site: 'x', typ: typKey }], { x: fakten });
  for (const k of konflikte) q.hinweise.push({ art: 'fakten', stufe: 'fehler', text: ohneStriche(`Der Text weicht von den Fakten ab (${k.art}): im Text «${k.gefunden}», in den Fakten «${k.erwartet}».`) });
  q.ok = !q.hinweise.some(h => h.stufe === 'fehler');

  const fertig = {
    typ: typKey, label: typ.label, status: 'fertig', ...seite,
    aufEinenBlick: EF.aufEinenBlick(e, fakten, { sprache: job.system.sprache }),
    jsonld: EF.jsonLd(e, fakten, { faq: seite.faq, sprache: job.system.sprache }),
    qualitaet: q
  };
  if (job.importUrls[typKey]) fertig.importUrl = job.importUrls[typKey];

  // Verlauf: ein Eintrag je Seite wie bei der normalen Erzeugung
  try {
    const input = { tile: 'website', einheitId: job.einheit.id, seitentyp: typKey, paketId: job.id, text: `Seitenpaket: ${typ.label}, ${e.name}` };
    const [inputDb, resultDb] = await require('./speicherSchutz').schuetzeAlle(input, seiteAlsText(seite));
    const { rows } = await pool.query(
      `INSERT INTO analyses (client_id, advisor_id, module, module_label, input_data, result, generated_by, had_brand_voice, feedback_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [job.clientId, job.advisorId, MODUL, 'Text Generator', JSON.stringify(inputDb), resultDb, job.userRef, job.system.hatBrandVoice, TEXTART_KEY]
    );
    fertig.analysisId = rows[0].id;
    if (job.notify) job.notify({ type: 'analysis', id: rows[0].id, clientId: job.clientId });
  } catch (err) { console.error('[webseitenPaket] Verlaufseintrag fehlgeschlagen:', err.message); }
  return fertig;
}

// ---------- Lauf ----------

function endstatus(seiten) {
  const f = seiten.filter(s => s.status === 'fertig').length;
  const x = seiten.filter(s => s.status === 'fehler').length;
  if (f === seiten.length) return 'fertig';
  if (x === seiten.length) return 'fehler';
  return 'teilweise';
}

async function ausfuehren(job) {
  laufende.add(job.id);
  const seiten = job.seiten;
  let kette = Promise.resolve();
  // Schreibzugriffe nacheinander, damit ein langsamer Lauf nie einen neueren Stand überschreibt
  const speichern = (status) => {
    const fertig = seiten.filter(s => s.status === 'fertig' || s.status === 'fehler').length;
    const json = JSON.stringify(seiten);
    kette = kette.then(() => pool.query('UPDATE webseiten_pakete SET seiten=$1, fertig=$2, status=COALESCE($3,status), updated_at=NOW() WHERE id=$4', [json, fertig, status || null, job.id]))
      .catch(e => console.error('[webseitenPaket] Speichern fehlgeschlagen:', e.message));
    return kette;
  };
  try {
    job.system = await systemFuer(job.clientId, job.einheit.id);
    let next = 0;
    const arbeiter = async () => {
      while (next < seiten.length) {
        const i = next++;
        const s = seiten[i];
        s.status = 'laeuft';
        await speichern();
        try {
          seiten[i] = await seiteErzeugen(job, s.typ, i);
        } catch (err) {
          const m = err && err.datenwaechter ? err.message : (err && err.message) || 'Unbekannter Fehler';
          console.error('[webseitenPaket] Seite', s.typ, 'fehlgeschlagen:', String(m).slice(0, 200));
          seiten[i] = { ...leer(), typ: s.typ, label: s.label, status: 'fehler', titel: '', beschreibung: '', h1: '', h2: [], text: '', faq: [], fehler: String(m).slice(0, 300) };
        }
        await speichern();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, seiten.length) }, arbeiter));
    await speichern(endstatus(seiten));
  } catch (err) {
    console.error('[webseitenPaket] Lauf abgebrochen:', err.message);
    for (const s of seiten) if (s.status === 'laeuft' || s.status === 'offen') { s.status = 'fehler'; s.fehler = 'Der Lauf wurde abgebrochen.'; }
    await speichern(seiten.some(s => s.status === 'fertig') ? 'teilweise' : 'fehler');
  } finally {
    await kette;
    laufende.delete(job.id);
  }
}

// Legt die Zeile an und startet den Lauf im Hintergrund (ohne Warten). Voraussetzung: alle Prüfungen der Route sind bestanden.
async function starte({ clientId, einheit, typen, stichworte, importUrls, advisorId, userRef, notify, meterStore }) {
  await ensureSchema();
  const seiten = typen.map(t => ({ ...leer(), typ: t, label: GS.SEITENTYPEN[t].label, status: 'offen', titel: '', beschreibung: '', h1: '', h2: [], text: '', faq: [] }));
  const { rows } = await pool.query(
    `INSERT INTO webseiten_pakete (client_id, einheit_id, advisor_id, user_ref, status, seiten, gesamt, fertig) VALUES ($1,$2,$3,$4,'laeuft',$5,$6,0) RETURNING id`,
    [clientId, einheit.id, advisorId || null, userRef || null, JSON.stringify(seiten), seiten.length]
  );
  const job = {
    id: rows[0].id, clientId, advisorId: advisorId || null, userRef: userRef || null, einheit,
    fakten: EF.normalisiere(parseJson(einheit.fakten_json, {})).fakten,
    seiten, stichworte: stichworte || {}, importUrls: importUrls || {}, notify
  };
  // Kontext für Verbrauchszählung und Daten-Wächter bleibt im Hintergrundlauf erhalten
  const meter = require('./meter');
  const store = meterStore || { advisorId: advisorId || null, clientId, module: MODUL };
  laufende.add(job.id);
  meter.run(store, () => { ausfuehren(job).catch(e => console.error('[webseitenPaket]', e.message)); });
  return { id: job.id, status: 'laeuft', gesamt: seiten.length };
}

// Wartet in Tests, bis ein Paket nicht mehr läuft
async function warteBis(id, maxMs = 15000) {
  const t0 = Date.now();
  while (laufende.has(id) && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 10));
}

// ---------- Lesen ----------

function ausZeile(r, mitSeiten, einheitName) {
  const out = {
    id: r.id, einheitId: r.einheit_id, einheitName: einheitName != null ? einheitName : (r.einheit_name || ''),
    status: r.status, gesamt: r.gesamt, fertig: r.fertig, erstelltAm: r.created_at
  };
  if (mitSeiten) out.seiten = parseJson(r.seiten, []);
  return out;
}

// Läuft laut Datenbank, aber nicht mehr in diesem Prozess und seit 30 Minuten ohne Bewegung: unterbrochen
async function unterbrochenPruefen(r) {
  if (r.status !== 'laeuft' || laufende.has(r.id)) return r;
  if (Date.now() - new Date(r.updated_at).getTime() < 30 * 60 * 1000) return r;
  await pool.query(`UPDATE webseiten_pakete SET status='unterbrochen' WHERE id=$1 AND status='laeuft'`, [r.id]);
  return { ...r, status: 'unterbrochen' };
}

// Standort-Namen für den Check: Name, bei Dopplungen mit Nummer
function siteNamen(einheiten) {
  const zaehler = {};
  einheiten.forEach(e => { zaehler[e.name] = (zaehler[e.name] || 0) + 1; });
  const m = {};
  einheiten.forEach(e => { m[e.id] = zaehler[e.name] > 1 ? `${e.name} (${e.id})` : e.name; });
  return m;
}

// Gesamtprüfung über die jüngste Fassung jedes Seitentyps je Restaurant des Kunden
async function checkFuer(clientId) {
  await ensureSchema();
  const { rows: ein } = await pool.query('SELECT id, name, fakten_json FROM einheiten WHERE client_id=$1', [clientId]);
  const namen = siteNamen(ein);
  const faktenProSite = {};
  ein.forEach(e => { faktenProSite[namen[e.id]] = EF.normalisiere(parseJson(e.fakten_json, {})).fakten; });
  const { rows } = await pool.query('SELECT id, einheit_id, seiten, created_at FROM webseiten_pakete WHERE client_id=$1 ORDER BY created_at DESC, id DESC LIMIT 60', [clientId]);
  const gesehen = new Set();
  const seiten = [];
  for (const r of rows) {
    if (!namen[r.einheit_id]) continue;
    for (const s of parseJson(r.seiten, [])) {
      if (s.status !== 'fertig') continue;
      const k = r.einheit_id + '|' + s.typ;
      if (gesehen.has(k)) continue;
      gesehen.add(k);
      seiten.push({ id: `${r.id}:${s.typ}`, site: namen[r.einheit_id], typ: s.typ, titel: s.titel, beschreibung: s.beschreibung, h1: s.h1, h2: s.h2, text: s.text, faq: s.faq });
    }
  }
  const zielProTyp = {};
  for (const t of Object.values(GS.SEITENTYPEN)) zielProTyp[t.key] = { laengeWoerter: t.laengeWoerter, faqNoetig: t.faqFragen.length > 0 };
  const z = WC.zusammenfassung(seiten, { zielProTyp, faktenProSite });
  // Map ist nicht als JSON lesbar: als Objekt je Restaurant ausgeben
  const luecken = {};
  for (const [site, liste] of z.luecken) luecken[site] = liste;
  return { ...z, luecken };
}

// ---------- Word-Export ----------

function docxFuer(paket) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ShadingType, PageBreak } = require('docx');
  const p = (t, o = {}) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: ohneStriche(t), ...o })] });
  const h = (t, level) => new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun(ohneStriche(t))] });
  const feld = (name, wert) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: name + ': ', bold: true }), new TextRun(ohneStriche(wert))] });
  const code = (zeile) => new Paragraph({
    spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
    children: [new TextRun({ text: zeile.replace(/\t/g, '  ') || ' ', font: 'Courier New', size: 16 })]
  });
  const kinder = [];
  kinder.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(ohneStriche('Seitenpaket ' + (paket.einheitName || '')))] }));
  kinder.push(p(`Erstellt am ${new Date(paket.erstelltAm).toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })}, ${paket.seiten.filter(s => s.status === 'fertig').length} von ${paket.gesamt} Seiten fertig.`));
  paket.seiten.forEach((s, idx) => {
    if (idx > 0) kinder.push(new Paragraph({ children: [new PageBreak()] }));
    kinder.push(h(s.label || s.typ, HeadingLevel.HEADING_1));
    if (s.status !== 'fertig') { kinder.push(p(s.status === 'fehler' ? 'Diese Seite konnte nicht erzeugt werden: ' + (s.fehler || '') : 'Diese Seite ist noch nicht fertig.')); return; }
    kinder.push(feld('Titel', s.titel || ''));
    kinder.push(feld('Beschreibung', s.beschreibung || ''));
    kinder.push(feld('H1', s.h1 || ''));
    // Text mit Zwischenüberschriften: Zeilen «H2: ...» werden zu Überschriften
    kinder.push(h('Text', HeadingLevel.HEADING_2));
    for (const zeile of String(s.text || '').split('\n')) {
      const m = /^\s*[*#_\s]*H2[*_\s]*:[*_\s]*(.+)$/i.exec(zeile);
      if (m) kinder.push(h(m[1].trim(), HeadingLevel.HEADING_3));
      else if (zeile.trim()) kinder.push(p(zeile.trim()));
    }
    if (s.aufEinenBlick && s.aufEinenBlick.length) {
      kinder.push(h('Auf einen Blick', HeadingLevel.HEADING_2));
      s.aufEinenBlick.forEach(z => kinder.push(feld(z.label, z.wert)));
    }
    if (s.faq && s.faq.length) {
      kinder.push(h('Häufige Fragen', HeadingLevel.HEADING_2));
      s.faq.forEach(f => { kinder.push(p(f.frage, { bold: true })); kinder.push(p(f.antwort)); });
    }
    if (s.jsonld) {
      kinder.push(h('JSON-LD', HeadingLevel.HEADING_2));
      String(s.jsonld).split('\n').forEach(z => kinder.push(code(z)));
    }
    const q = s.qualitaet || { hinweise: [], luecken: [] };
    kinder.push(h('Hinweise', HeadingLevel.HEADING_2));
    if (q.hinweise && q.hinweise.length) q.hinweise.forEach(x => kinder.push(p((x.stufe === 'fehler' ? 'Fehler: ' : 'Hinweis: ') + x.text)));
    else kinder.push(p('Keine Hinweise.'));
    kinder.push(h('Offene Lücken', HeadingLevel.HEADING_2));
    if (q.luecken && q.luecken.length) q.luecken.forEach(x => kinder.push(p(x)));
    else kinder.push(p('Keine offenen Lücken.'));
  });
  const doc = new Document({ sections: [{ children: kinder }] });
  return Packer.toBuffer(doc);
}

module.exports = {
  abruf, laufende, PARALLEL, MAX_SEITEN,
  waehleTypen, stichworteAus, importUrlsAus, kontingentPruefen,
  starte, warteBis, ausZeile, unterbrochenPruefen, checkFuer, docxFuer, seiteAlsText
};
