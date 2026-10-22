// Monatliche Finanzaufstellung der Beraterin (totale Finanzrechnung): Einnahmen, Kosten, Ergebnis, alles in CHF auf Rappen genau.
// Die Rechnung (compute) ist rein und testbar. Stripe wird als Objekt eingespeist (Tests nutzen eine Attrappe).
// Intern wird in Rappen (ganze Zahlen) gerechnet, damit Summen immer aufgehen.
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { monthRange, clientSummary } = require('./reviewTime');
const { planPriceChf, USD_PER_CHF } = require('./costAlerts');
const { shares, LIMIT_PERCENT } = require('./revenueShare');
const { COST_SQL } = require('./meter');
const { csvCell } = require('./csvSafe');

const FEE_PERCENT = 2.9, FEE_FIX_CENTS = 30;
const CACHE_MS = 10 * 60 * 1000;

// Kategorien der Einnahmen. immer = die Zeile steht auch bei 0, sonst nur bei einem Betrag.
const GRUPPEN = [
  { key: 'abos', label: 'Bezahlte Abos' },
  { key: 'module', label: 'Zusatzmodule' },
  { key: 'zusatz', label: 'Zusatzkäufe' },
  { key: 'einmalig', label: 'Einmalige Leistungen' },
  { key: 'beratung', label: 'Zusätzliche Beratung' },
  { key: 'nz', label: 'Nicht zugeordnet' }
];
const KATS = [
  { key: 'abo_stimme', g: 'abos', label: 'Paket Stimme', immer: true },
  { key: 'abo_team', g: 'abos', label: 'Paket Team', immer: true },
  { key: 'abo_business', g: 'abos', label: 'Paket Business', immer: true },
  { key: 'abo_enterprise', g: 'abos', label: 'Paket Enterprise', immer: true },
  { key: 'abo_alt', g: 'abos', label: 'Frühere Pakete (Starter und altes Team)' },
  { key: 'themenplan', g: 'module', label: 'Themenplan und Newsletter', immer: true },
  { key: 'quartalsreview', g: 'module', label: 'Quartalsreview', immer: true },
  { key: 'branchen', g: 'module', label: 'Branchenpakete', immer: true },
  { key: 'topup', g: 'zusatz', label: '+20 Texte', immer: true },
  { key: 'karte', g: 'zusatz', label: '10er-Karte Überarbeitungen', immer: true },
  { key: 'audit', g: 'einmalig', label: 'Stimm-Audit', immer: true },
  { key: 'workshop_team', g: 'einmalig', label: 'Workshop Team', immer: true },
  { key: 'workshop_business', g: 'einmalig', label: 'Workshop Business', immer: true },
  { key: 'einrichtung_sonst', g: 'einmalig', label: 'Weitere Einrichtung' },
  { key: 'beratung', g: 'beratung', label: 'Mehraufwand nach Zeiterfassung', immer: true },
  { key: 'nicht_zugeordnet', g: 'nz', label: 'Nicht zugeordnet (bitte prüfen)' }
];
const KAT = Object.fromEntries(KATS.map(k => [k.key, k]));

// Monatspreise in Rappen (Betragstabelle aus lib/angebote.js und routes/subscriptions.js TIERS)
const ABO_MONAT = { 19000: 'abo_stimme', 59000: 'abo_team', 149000: 'abo_business', 249000: 'abo_enterprise', 29000: 'abo_alt', 99000: 'abo_alt' };
// Jahrespreise: 10 Prozent Rabatt (lib/yearlyPlan.js)
const ABO_JAHR = { 205200: 'abo_stimme', 637200: 'abo_team', 1609200: 'abo_business' };
const EINMAL = { 4900: 'topup', 69000: 'karte', 95000: 'audit', 390000: 'workshop_team', 500000: 'workshop_business' };
const PAKET_KAT = { stimme: 'abo_stimme', team: 'abo_team', business: 'abo_business', enterprise: 'abo_enterprise' };
const ABO_KEYS = new Set(['abo_stimme', 'abo_team', 'abo_business', 'abo_enterprise', 'abo_alt']);
const WIEDERKEHREND = new Set([...ABO_KEYS, 'themenplan', 'quartalsreview', 'branchen']);

const REGELN = [
  'Quelle der Einnahmen ist Stripe (bezahlte Zahlungen). Die Zuordnung zu Kategorien folgt den Angaben zur Zahlung (Typ, Angebot, Klient) und danach dem Betrag laut Preisliste. Was sich keiner Kategorie zuordnen lässt, steht unter «Nicht zugeordnet».',
  'Jahresabos zählen im Zahlungsmonat voll als Einnahme (Geldfluss). Für den wiederkehrenden Monatsumsatz (MRR) wird ein Jahresabo durch 12 geteilt, ein Quartalsreview durch 3.',
  'Rückerstattungen stehen als eigene Zeile mit Minus und gelten im Monat der ursprünglichen Zahlung.',
  'Die Zusatzberatung stammt aus der Zeiterfassung (CHF 180 pro Stunde im 15-Minuten-Takt, nach Abzug der Karten). Wurde sie über Stripe bezahlt, erscheint sie zusätzlich unter «Nicht zugeordnet». Bitte dann dort prüfen.',
  'KI-Kosten stammen aus dem Nutzungsprotokoll (US-Dollar) und werden mit dem Wechselkurs in Franken umgerechnet. Trägst du die tatsächliche Anthropic-Rechnung ein, rechnet die Aufstellung mit diesem Wert.'
];

// ───────── Hilfen ─────────
const toCents = v => Math.round(Number(v || 0) * 100);
const c2 = cents => Math.round(cents) / 100;
function monthOfSec(sec) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit' }).format(new Date(sec * 1000));
  return p.slice(0, 7);
}
function prevMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return d.toISOString().slice(0, 7);
}
function chf(n) {
  const v = Math.round(Number(n || 0) * 100) / 100, neg = v < 0, s = Math.abs(v).toFixed(2), [i, d] = s.split('.');
  return 'CHF ' + (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, "'") + '.' + d;
}
function fehler(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ───────── Einordnung einer Zahlung ─────────
function klassiere(it) {
  if (it.kat) return it.kat;
  const m = it.meta || {}, type = String(m.type || '').toLowerCase(), ang = String(m.angebot || '').toLowerCase();
  const a = it.amountCents, iv = it.interval, cnt = it.intervalCount || 1;
  if (type === 'topup') return 'topup';
  if (type === 'karte') return 'karte';
  if (type === 'themenplan') return 'themenplan';
  if (type === 'quartalsreview') return 'quartalsreview';
  if (/^branchen/.test(type) || /^branchen/.test(ang)) return 'branchen';
  if (ang === 'stimm-audit') return 'audit';
  if (ang === 'workshop-team') return 'workshop_team';
  if (ang === 'workshop-business') return 'workshop_business';
  if (type === 'einrichtung') return EINMAL[a] && ['audit', 'workshop_team', 'workshop_business'].includes(EINMAL[a]) ? EINMAL[a] : 'einrichtung_sonst';
  if (PAKET_KAT[ang]) return PAKET_KAT[ang];
  if (type === 'upgrade' || type === 'choose-plan') {
    const t = String(m.targetTier || '').toLowerCase();
    if (PAKET_KAT[t]) return PAKET_KAT[t];
  }
  // Ohne Angaben entscheidet der Betrag
  if (iv === 'year') return ABO_JAHR[a] || 'nicht_zugeordnet';
  if (iv === 'month' && cnt === 3 && a === 29000) return 'quartalsreview';
  if (iv && a === 15000) return 'themenplan';
  if (ABO_MONAT[a] && (iv || !EINMAL[a])) return ABO_MONAT[a];
  if (EINMAL[a]) return EINMAL[a];
  return 'nicht_zugeordnet';
}

// Teilt den Betrag auf einen Monatsbetrag für den wiederkehrenden Umsatz (MRR) herunter
function monatsAnteil(it, kat) {
  if (!WIEDERKEHREND.has(kat)) return 0;
  if (it.interval === 'year') return it.amountCents / 12;
  if (kat === 'quartalsreview' || (it.interval === 'month' && (it.intervalCount || 1) === 3)) return it.amountCents / 3;
  return it.amountCents;
}

// ───────── Reine Rechnung ─────────
function einstellungenNorm(e) {
  e = e || {};
  const anz = e.mwst_anzeige === 'brutto' ? 'brutto' : 'netto';
  return {
    mwst_pflichtig: e.mwst_pflichtig === true || e.mwst_pflichtig === 't' || e.mwst_pflichtig === 'true',
    mwst_satz: e.mwst_satz != null && e.mwst_satz !== '' ? Number(e.mwst_satz) : 8.1,
    mwst_anzeige: anz,
    wechselkurs: e.wechselkurs != null && e.wechselkurs !== '' && Number(e.wechselkurs) > 0 ? Number(e.wechselkurs) : null,
    rueckstellung_prozent: e.rueckstellung_prozent != null && e.rueckstellung_prozent !== '' ? Number(e.rueckstellung_prozent) : 0
  };
}

function fixkostenImMonat(list, month) {
  return (list || []).filter(f => {
    const ab = f.gueltig_ab || null, bis = f.gueltig_bis || null;
    if (f.wiederkehrend === false) return ab ? ab === month : true;
    return (!ab || ab <= month) && (!bis || bis >= month);
  });
}

function compute(input) {
  const month = input.month;
  const einst = einstellungenNorm(input.einstellungen);
  const own = new Map((input.clients || []).map(c => [Number(c.id), c.name]));
  const rate = einst.wechselkurs || input.usdPerChf || USD_PER_CHF;
  const netto = einst.mwst_pflichtig && einst.mwst_anzeige === 'netto';
  const faktor = 1 + einst.mwst_satz / 100;
  const conv = cents => (netto ? Math.round(cents / faktor) : Math.round(cents));

  const lines = Object.fromEntries(KATS.map(k => [k.key, { anzahl: 0, klienten: new Set(), cents: 0 }]));
  const clientEin = new Map(); // id oder 0 -> Rappen
  let rueck = 0, rohNetto = 0, feeCents = 0, feeGeschaetzt = false, mrr = 0, fremd = 0, zahlungen = 0;

  const add = (it, kat) => {
    const cid = it.meta && it.meta.clientId != null && /^\d+$/.test(String(it.meta.clientId)) ? Number(it.meta.clientId) : null;
    const L = lines[kat];
    const brutto = conv(it.amountCents), r = conv(it.refundedCents || 0);
    L.anzahl += 1; L.cents += brutto; rueck += r; rohNetto += it.amountCents - (it.refundedCents || 0);
    if (cid != null) L.klienten.add(cid);
    const key = cid != null && kat !== 'nicht_zugeordnet' ? cid : 0;
    clientEin.set(key, (clientEin.get(key) || 0) + brutto - r);
    mrr += conv(monatsAnteil(it, kat)) * ((it.amountCents - (it.refundedCents || 0)) > 0 ? 1 : 0);
    zahlungen += 1;
  };

  for (const it of (input.items || [])) {
    if (it.month !== month) continue;
    const cid = it.meta && it.meta.clientId != null && /^\d+$/.test(String(it.meta.clientId)) ? Number(it.meta.clientId) : null;
    if (cid != null && !own.has(cid)) { fremd += 1; continue; } // Kliententrennung: nur eigene Klienten
    const kat = klassiere(it);
    add(it, kat);
    if (it.feeCents != null) feeCents += it.feeCents;
    else { feeCents += Math.round(it.amountCents * FEE_PERCENT / 100) + FEE_FIX_CENTS; feeGeschaetzt = true; }
  }
  // Zusatzberatung aus der Zeiterfassung
  for (const [id, v] of Object.entries(input.mehraufwand || {})) {
    const cents = toCents(v);
    if (cents > 0 && own.has(Number(id))) add({ amountCents: cents, refundedCents: 0, meta: { clientId: Number(id) }, kat: 'beratung' }, 'beratung');
  }

  // Zeilen der Einnahmen
  const gruppen = GRUPPEN.map(g => {
    const zeilen = KATS.filter(k => k.g === g.key).map(k => {
      const L = lines[k.key];
      return { key: k.key, label: k.label, anzahl: L.anzahl, klienten: L.klienten.size, betragChf: c2(L.cents), immer: !!k.immer };
    }).filter(z => z.immer || z.anzahl > 0);
    return { key: g.key, label: g.label, zeilen, summeChf: c2(zeilen.reduce((s, z) => s + Math.round(z.betragChf * 100), 0)) };
  }).filter(g => g.zeilen.length);
  const einnahmenCents = KATS.reduce((s, k) => s + lines[k.key].cents, 0) - rueck;
  const bruttoCents = KATS.reduce((s, k) => s + lines[k.key].cents, 0);

  // MwSt-Hinweis
  let mwst = { pflichtig: false, satz: einst.mwst_satz, anzeige: einst.mwst_anzeige, betragChf: 0, text: 'Keine Mehrwertsteuer gerechnet (nicht mehrwertsteuerpflichtig). Die Beträge stehen so, wie sie bezahlt wurden.' };
  if (einst.mwst_pflichtig) {
    const satzTxt = einst.mwst_satz + ' Prozent';
    if (netto) {
      const sumNetto = einnahmenCents, enthalten = Math.round(rohNetto - sumNetto);
      mwst = { pflichtig: true, satz: einst.mwst_satz, anzeige: 'netto', betragChf: c2(enthalten),
        text: `Mehrwertsteuerpflichtig mit ${satzTxt}. Alle Einnahmen sind ohne Mehrwertsteuer (netto) ausgewiesen. Die in den Zahlungen enthaltene Mehrwertsteuer von ${chf(c2(enthalten))} gehört dem Staat und ist nicht Teil des Ergebnisses. Kosten stehen so, wie sie eingetragen sind (keine Vorsteuer gerechnet).` };
    } else {
      const enthalten = Math.round(bruttoCents - rueck - (bruttoCents - rueck) / faktor);
      mwst = { pflichtig: true, satz: einst.mwst_satz, anzeige: 'brutto', betragChf: c2(enthalten),
        text: `Mehrwertsteuerpflichtig mit ${satzTxt}. Die Einnahmen sind inklusive Mehrwertsteuer (brutto) ausgewiesen. Darin stecken ${chf(c2(enthalten))} Mehrwertsteuer, die du abliefern musst. Das Ergebnis ist deshalb höher als der echte Gewinn.` };
    }
  }

  // KI-Kosten
  const kiClient = new Map(); // id oder 0 -> { cents, module: Map }
  let kiCents = 0, kiUsd = 0;
  for (const r of (input.kiRows || [])) {
    const cid = r.clientId != null ? Number(r.clientId) : null;
    if (cid != null && !own.has(cid)) continue;
    const key = cid != null ? cid : 0, cents = Math.round(Number(r.usd || 0) / rate * 100);
    kiUsd += Number(r.usd || 0);
    const e = kiClient.get(key) || { cents: 0, module: new Map() };
    e.cents += cents; e.module.set(r.module || 'ki', (e.module.get(r.module || 'ki') || 0) + cents);
    kiClient.set(key, e); kiCents += cents;
  }
  const gebucht = input.gebuchtChf != null && input.gebuchtChf !== '' && Number.isFinite(Number(input.gebuchtChf)) ? toCents(input.gebuchtChf) : null;
  const kiVerbucht = gebucht != null ? gebucht : kiCents;
  const skala = gebucht != null && kiCents > 0 ? gebucht / kiCents : 1;

  // Weitere Kosten
  const aktiv = fixkostenImMonat(input.fixkosten, month);
  const posten = a => aktiv.filter(f => (f.art || 'fix') === a).map(f => ({ id: f.id, name: f.name, betragChf: c2(toCents(f.betrag_chf)), wiederkehrend: f.wiederkehrend !== false }));
  const fixP = posten('fix'), varP = posten('variabel');
  const fixCents = fixP.reduce((s, p) => s + Math.round(p.betragChf * 100), 0), varCents = varP.reduce((s, p) => s + Math.round(p.betragChf * 100), 0);

  const kostenCents = kiVerbucht + feeCents + varCents + fixCents;
  const ergebnisCents = einnahmenCents - kostenCents;
  const marge = einnahmenCents > 0 ? Math.round(ergebnisCents / einnahmenCents * 1000) / 10 : null;
  const kiProzent = einnahmenCents > 0 ? Math.round(kiVerbucht / einnahmenCents * 1000) / 10 : null;
  const rueckPct = Number(einst.rueckstellung_prozent) || 0;
  const rueckstellungCents = ergebnisCents > 0 ? Math.round(ergebnisCents * rueckPct / 100) : 0;

  // Klienten
  const ids = new Set([...clientEin.keys(), ...kiClient.keys()]);
  const klienten = [...ids].map(id => {
    const ein = clientEin.get(id) || 0, ki = kiClient.get(id), kiC = ki ? Math.round(ki.cents * skala) : 0;
    return {
      clientId: id || null, name: id ? (own.get(id) || 'Klient ' + id) : 'Ohne Klient (nicht zugeordnet)',
      einnahmenChf: c2(ein), kiKostenChf: c2(kiC), ergebnisChf: c2(ein - kiC),
      module: ki ? [...ki.module.entries()].map(([module, cents]) => ({ module, chf: c2(Math.round(cents * skala)) })).sort((a, b) => b.chf - a.chf) : []
    };
  }).filter(k => k.einnahmenChf !== 0 || k.kiKostenChf !== 0).sort((a, b) => b.einnahmenChf - a.einnahmenChf || a.name.localeCompare(b.name, 'de'));
  const sh = shares(klienten.filter(k => k.clientId).map(k => ({ clientId: k.clientId, name: k.name, umsatzChf: k.einnahmenChf })), LIMIT_PERCENT);
  const zahlende = klienten.filter(k => k.clientId && k.einnahmenChf > 0).length;

  const hinweise = [];
  if (feeGeschaetzt) hinweise.push('Stripe-Gebühren teilweise geschätzt (2.9 Prozent plus CHF 0.30 je Zahlung).');
  if (lines.nicht_zugeordnet.anzahl > 0) hinweise.push(`${lines.nicht_zugeordnet.anzahl} Zahlung(en) mit ${chf(c2(lines.nicht_zugeordnet.cents))} liessen sich keiner Kategorie zuordnen. Bitte in Stripe prüfen.`);
  if (fremd > 0) hinweise.push(`${fremd} Zahlung(en) gehören zu Klienten anderer Beraterinnen und sind nicht enthalten.`);

  return {
    month, quelle: input.quelle || 'stripe', schaetzung: input.quelle === 'schaetzung',
    einnahmen: { gruppen, rueckerstattungenChf: -c2(rueck), summeChf: c2(einnahmenCents), mwst },
    kosten: {
      ki: { berechnetChf: c2(kiCents), berechnetUsd: Math.round(kiUsd * 100) / 100, gebuchtChf: gebucht != null ? c2(gebucht) : null, verwendetChf: c2(kiVerbucht), wechselkurs: rate, mitGebuchtemWert: gebucht != null },
      stripeGebuehren: { betragChf: c2(feeCents), geschaetzt: feeGeschaetzt || input.quelle === 'schaetzung' },
      variable: { posten: varP, summeChf: c2(varCents) },
      fix: { posten: fixP, summeChf: c2(fixCents) },
      summeChf: c2(kostenCents)
    },
    ergebnisChf: c2(ergebnisCents), margeProzent: marge, kiProzentVomUmsatz: kiProzent,
    rueckstellung: { prozent: rueckPct, betragChf: c2(rueckstellungCents), nachRueckstellungChf: c2(ergebnisCents - rueckstellungCents) },
    kennzahlen: { zahlendeKlienten: zahlende, mrrChf: c2(mrr), arrChf: c2(mrr * 12), top5: sh.klienten.slice(0, 5), klumpenrisiko: sh.zuHoch.map(z => ({ clientId: z.clientId, name: z.name, anteilProzent: z.anteilProzent })), limitProzent: LIMIT_PERCENT },
    klienten, hinweise, regeln: REGELN
  };
}

function vergleich(cur, prev) {
  const d = (a, b) => ({ aktuell: a, vormonat: b, differenzChf: Math.round((a - b) * 100) / 100, prozent: b !== 0 ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null });
  return { monat: prev.month, einnahmen: d(cur.einnahmen.summeChf, prev.einnahmen.summeChf), kosten: d(cur.kosten.summeChf, prev.kosten.summeChf), ergebnis: d(cur.ergebnisChf, prev.ergebnisChf) };
}

// ───────── Datenbank ─────────
async function einstellungenLesen(advisorId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM finanz_einstellungen WHERE advisor_id=$1', [advisorId]);
  return einstellungenNorm(rows[0]);
}
async function einstellungenSpeichern(advisorId, b) {
  await ensureSchema();
  const cur = await einstellungenLesen(advisorId);
  const n = { ...cur };
  if (b.mwst_pflichtig !== undefined) n.mwst_pflichtig = b.mwst_pflichtig === true || b.mwst_pflichtig === 'true';
  if (b.mwst_satz !== undefined) {
    const v = Number(String(b.mwst_satz).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 30) throw fehler('Der Mehrwertsteuersatz muss zwischen 0 und 30 Prozent liegen.');
    n.mwst_satz = Math.round(v * 100) / 100;
  }
  if (b.mwst_anzeige !== undefined) {
    if (!['brutto', 'netto'].includes(b.mwst_anzeige)) throw fehler('Die Anzeige muss «brutto» oder «netto» sein.');
    n.mwst_anzeige = b.mwst_anzeige;
  }
  if (b.wechselkurs !== undefined) {
    if (b.wechselkurs === null || b.wechselkurs === '') n.wechselkurs = null;
    else {
      const v = Number(String(b.wechselkurs).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0.3 || v > 3) throw fehler('Der Wechselkurs (US-Dollar für 1 Franken) muss zwischen 0.3 und 3 liegen.');
      n.wechselkurs = Math.round(v * 10000) / 10000;
    }
  }
  if (b.rueckstellung_prozent !== undefined) {
    const v = Number(String(b.rueckstellung_prozent === '' ? 0 : b.rueckstellung_prozent).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 60) throw fehler('Die Rückstellung muss zwischen 0 und 60 Prozent liegen.');
    n.rueckstellung_prozent = Math.round(v * 100) / 100;
  }
  await pool.query(
    `INSERT INTO finanz_einstellungen (advisor_id, mwst_pflichtig, mwst_satz, mwst_anzeige, wechselkurs, rueckstellung_prozent)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (advisor_id) DO UPDATE SET mwst_pflichtig=$2, mwst_satz=$3, mwst_anzeige=$4, wechselkurs=$5, rueckstellung_prozent=$6`,
    [advisorId, n.mwst_pflichtig, n.mwst_satz, n.mwst_anzeige, n.wechselkurs, n.rueckstellung_prozent]);
  return n;
}

const MONAT_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function fixkostenPruefen(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) throw fehler('Bitte gib eine Bezeichnung mit höchstens 80 Zeichen an.');
  const betrag = Number(String(b.betrag_chf == null ? '' : b.betrag_chf).replace(',', '.'));
  if (!Number.isFinite(betrag) || betrag < 0 || betrag > 1000000) throw fehler('Der Betrag muss zwischen 0 und 1 000 000 Franken liegen.');
  const art = b.art === 'variabel' ? 'variabel' : 'fix';
  const ab = b.gueltig_ab ? String(b.gueltig_ab).slice(0, 7) : null, bis = b.gueltig_bis ? String(b.gueltig_bis).slice(0, 7) : null;
  if ((ab && !MONAT_RE.test(ab)) || (bis && !MONAT_RE.test(bis))) throw fehler('Gültig ab und bis brauchen das Format Jahr-Monat, zum Beispiel 2026-10.');
  if (ab && bis && bis < ab) throw fehler('«Gültig bis» liegt vor «gültig ab».');
  return { name, betrag: Math.round(betrag * 100) / 100, art, wiederkehrend: b.wiederkehrend !== false && b.wiederkehrend !== 'false', ab, bis };
}
async function fixkostenListe(advisorId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT id, name, betrag_chf, art, wiederkehrend, gueltig_ab, gueltig_bis FROM finanz_fixkosten WHERE advisor_id=$1 ORDER BY art, name, id', [advisorId]);
  return rows.map(r => ({ ...r, betrag_chf: Number(r.betrag_chf) }));
}
async function fixkostenNeu(advisorId, b) {
  await ensureSchema();
  const v = fixkostenPruefen(b);
  const { rows } = await pool.query(
    `INSERT INTO finanz_fixkosten (advisor_id, name, betrag_chf, art, wiederkehrend, gueltig_ab, gueltig_bis) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [advisorId, v.name, v.betrag, v.art, v.wiederkehrend, v.ab, v.bis]);
  return rows[0].id;
}
async function fixkostenAendern(advisorId, id, b) {
  await ensureSchema();
  const v = fixkostenPruefen(b);
  const r = await pool.query(
    `UPDATE finanz_fixkosten SET name=$3, betrag_chf=$4, art=$5, wiederkehrend=$6, gueltig_ab=$7, gueltig_bis=$8 WHERE id=$1 AND advisor_id=$2 RETURNING id`,
    [id, advisorId, v.name, v.betrag, v.art, v.wiederkehrend, v.ab, v.bis]);
  return r.rows.length > 0;
}
async function fixkostenLoeschen(advisorId, id) {
  await ensureSchema();
  const r = await pool.query('DELETE FROM finanz_fixkosten WHERE id=$1 AND advisor_id=$2 RETURNING id', [id, advisorId]);
  return r.rows.length > 0;
}
async function anthropicSetzen(advisorId, month, wert) {
  await ensureSchema();
  if (!MONAT_RE.test(String(month))) throw fehler('Ungültiger Monat.');
  if (wert === null || wert === '' || wert === undefined) {
    await pool.query('DELETE FROM finanz_monat WHERE advisor_id=$1 AND monat=$2', [advisorId, month]);
    return null;
  }
  const v = Number(String(wert).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 1000000) throw fehler('Der Betrag der Anthropic-Rechnung muss zwischen 0 und 1 000 000 Franken liegen.');
  const r = Math.round(v * 100) / 100;
  await pool.query(
    `INSERT INTO finanz_monat (advisor_id, monat, anthropic_chf) VALUES ($1,$2,$3) ON CONFLICT (advisor_id, monat) DO UPDATE SET anthropic_chf=$3`,
    [advisorId, month, r]);
  return r;
}
async function anthropicLesen(advisorId, month) {
  const { rows } = await pool.query('SELECT anthropic_chf FROM finanz_monat WHERE advisor_id=$1 AND monat=$2', [advisorId, month]);
  return rows[0] && rows[0].anthropic_chf != null ? Number(rows[0].anthropic_chf) : null;
}

async function eigeneKlienten(advisorId) {
  const { rows } = await pool.query(
    `SELECT id, name, subscription_status, monthly_token_limit, themenplan_aktiv, quartalsreview_aktiv FROM clients
     WHERE (advisor_id=$1 OR advisor_id IS NULL) AND geloescht_am IS NULL ORDER BY name`, [advisorId]);
  return rows;
}
async function kiZeilen(advisorId, month, ownIds) {
  const r = monthRange(month), own = new Set(ownIds.map(Number));
  const { rows } = await pool.query(
    `SELECT client_id, module, SUM(${COST_SQL})::float AS usd FROM usage_log
     WHERE created_at >= $1 AND created_at < $2 AND (advisor_id=$3 OR advisor_id IS NULL)
     GROUP BY client_id, module`, [r.from, r.to, advisorId]);
  return rows.filter(x => x.client_id == null || own.has(Number(x.client_id))).map(x => ({ clientId: x.client_id, module: x.module, usd: Number(x.usd) }));
}
async function mehraufwandVon(clients, month) {
  const out = {};
  for (const c of clients) {
    const s = await clientSummary(c.id, month).catch(() => null);
    if (s && s.extraChf > 0) out[c.id] = s.extraChf;
  }
  return out;
}

// Schätzung aus der Datenbank, wenn Stripe fehlt: aktive Abos, aktive Zusätze und gekaufte Karten
async function schaetzungItems(clients, month) {
  const items = [];
  const katVon = chfPreis => ({ 190: 'abo_stimme', 590: 'abo_team', 1490: 'abo_business', 2490: 'abo_enterprise', 290: 'abo_alt', 990: 'abo_alt' }[chfPreis] || null);
  for (const c of clients) {
    const meta = { clientId: String(c.id) };
    if (/^(active|past_due)$/i.test(String(c.subscription_status || ''))) {
      const p = planPriceChf(c.monthly_token_limit), kat = p ? katVon(p) : null;
      if (kat) items.push({ id: 'db-abo-' + c.id, month, amountCents: p * 100, refundedCents: 0, feeCents: null, meta, kat, interval: 'month', intervalCount: 1, geschaetzt: true });
    }
    if (c.themenplan_aktiv === true) items.push({ id: 'db-tp-' + c.id, month, amountCents: 15000, refundedCents: 0, feeCents: null, meta, kat: 'themenplan', interval: 'month', intervalCount: 1, geschaetzt: true });
    if (c.quartalsreview_aktiv === true) items.push({ id: 'db-qr-' + c.id, month, amountCents: 9667, refundedCents: 0, feeCents: null, meta, kat: 'quartalsreview', interval: 'month', intervalCount: 1, geschaetzt: true });
  }
  const r = monthRange(month);
  const ids = new Set(clients.map(c => Number(c.id)));
  const { rows } = await pool.query('SELECT id, client_id FROM ueberarbeitungskarten WHERE gekauft_am >= $1 AND gekauft_am < $2', [r.from, r.to]);
  for (const k of rows) if (ids.has(Number(k.client_id))) items.push({ id: 'db-karte-' + k.id, month, amountCents: 69000, refundedCents: 0, feeCents: null, meta: { clientId: String(k.client_id) }, kat: 'karte', geschaetzt: true });
  return items;
}

// ───────── Stripe ─────────
const cache = new Map();
function leereCache() { cache.clear(); }

async function seiten(fn, params, max = 2000) {
  const out = [];
  let after;
  for (;;) {
    const r = await fn({ ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
    const data = (r && r.data) || [];
    out.push(...data);
    if (!r || !r.has_more || !data.length || out.length >= max) break;
    after = data[data.length - 1].id;
  }
  return out;
}

function normLadung(ch, sess) {
  if (!ch || ch.status !== 'succeeded' || ch.paid === false) return null;
  if (ch.currency && String(ch.currency).toLowerCase() !== 'chf') return { fremdwaehrung: true };
  const inv = ch.invoice && typeof ch.invoice === 'object' ? ch.invoice : null;
  const line = inv && inv.lines && inv.lines.data && inv.lines.data[0];
  const pi = typeof ch.payment_intent === 'string' ? ch.payment_intent : (ch.payment_intent && ch.payment_intent.id);
  const invId = inv ? inv.id : (typeof ch.invoice === 'string' ? ch.invoice : null);
  const sm = (pi && sess.byPi[pi]) || (invId && sess.byInv[invId]) || {};
  const meta = { ...(line && line.metadata), ...(inv && inv.metadata), ...(inv && inv.subscription_details && inv.subscription_details.metadata), ...sm, ...ch.metadata };
  let interval = null, intervalCount = 1;
  const rec = line && ((line.price && line.price.recurring) || (line.plan && { interval: line.plan.interval, interval_count: line.plan.interval_count }));
  if (rec && rec.interval) { interval = rec.interval; intervalCount = rec.interval_count || 1; }
  else if (line && line.period && line.period.start && line.period.end) {
    const days = (line.period.end - line.period.start) / 86400;
    if (days > 300) interval = 'year'; else if (days > 80) { interval = 'month'; intervalCount = 3; } else if (days > 20) interval = 'month';
  }
  if (interval === 'year' && intervalCount > 1) intervalCount = 1;
  const bt = ch.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
  const fee = bt && typeof bt.fee === 'number' && (!bt.currency || String(bt.currency).toLowerCase() === 'chf') ? bt.fee : null;
  return { id: ch.id, month: monthOfSec(ch.created), amountCents: ch.amount, refundedCents: ch.amount_refunded || 0, feeCents: fee, meta, interval, intervalCount };
}

// Lädt die Zahlungen von Vormonat und Monat. Gibt { items, fremdwaehrung } zurück. Zwischenspeicher: 10 Minuten.
async function ladeStripe(stripe, month, refresh) {
  const [y, mo] = month.split('-').map(Number);
  const from = Math.floor(Date.UTC(y, mo - 2, 1) / 1000) - 86400, to = Math.floor(Date.UTC(y, mo, 1) / 1000) + 86400;
  const key = `${from}:${to}`, hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const charges = await seiten(p => stripe.charges.list(p), { created: { gte: from, lt: to }, expand: ['data.balance_transaction', 'data.invoice'] });
  const sess = { byPi: {}, byInv: {} };
  try {
    const sl = await seiten(p => stripe.checkout.sessions.list(p), { created: { gte: from - 86400 * 7, lt: to } });
    for (const s of sl) {
      if (s.payment_intent) sess.byPi[typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id] = s.metadata || {};
      if (s.invoice) sess.byInv[typeof s.invoice === 'string' ? s.invoice : s.invoice.id] = s.metadata || {};
    }
  } catch (e) { console.error('[finanzen] Checkout-Sitzungen nicht lesbar:', e.message); }
  let fremdwaehrung = 0;
  const items = [];
  for (const ch of charges) {
    const n = normLadung(ch, sess);
    if (!n) continue;
    if (n.fremdwaehrung) { fremdwaehrung += 1; continue; }
    items.push(n);
  }
  const v = { items, fremdwaehrung };
  cache.set(key, { t: Date.now(), v });
  return v;
}

function stripeFehlerText(e) {
  const m = String((e && e.message) || '');
  if (/STRIPE_SECRET_KEY/.test(m)) return 'Stripe ist nicht eingerichtet (STRIPE_SECRET_KEY fehlt).';
  if (/rate/i.test(m) && /limit/i.test(m)) return 'Stripe hat die Anfragen vorübergehend begrenzt.';
  return 'Stripe ist im Moment nicht erreichbar.';
}

// ───────── Gesamtbericht ─────────
// getStripe: Funktion, die das Stripe-Objekt liefert oder wirft
async function bericht(advisorId, monthIn, opts = {}) {
  await ensureSchema();
  const month = monthRange(monthIn).month, vor = prevMonth(month);
  const einst = await einstellungenLesen(advisorId);
  const cl = await eigeneKlienten(advisorId);
  const fixkosten = await fixkostenListe(advisorId);
  const ids = cl.map(c => c.id);

  let items, quelle = 'stripe', stripeHinweis = null, fremdwaehrung = 0;
  try {
    const stripe = opts.getStripe();
    const r = await ladeStripe(stripe, month, opts.refresh);
    items = r.items; fremdwaehrung = r.fremdwaehrung;
  } catch (e) {
    console.error('[finanzen] Stripe:', e.message);
    quelle = 'schaetzung';
    stripeHinweis = stripeFehlerText(e);
    items = [...await schaetzungItems(cl, month), ...await schaetzungItems(cl, vor)];
  }
  const baue = async m => compute({
    month: m, clients: cl, items, quelle, einstellungen: einst,
    mehraufwand: await mehraufwandVon(cl, m), kiRows: await kiZeilen(advisorId, m, ids),
    fixkosten, gebuchtChf: await anthropicLesen(advisorId, m)
  });
  const cur = await baue(month), prev = await baue(vor);
  if (fremdwaehrung) cur.hinweise.push(`${fremdwaehrung} Zahlung(en) in einer anderen Währung als CHF sind nicht enthalten.`);
  cur.stripeHinweis = stripeHinweis;
  if (quelle === 'schaetzung') cur.hinweise.unshift(`Schätzung, nicht aus Stripe. ${stripeHinweis} Gerechnet wurde mit den Klienten mit bezahltem Abo (Stand heute), den aktiven Zusätzen und den gekauften Karten. Einmalige Käufe (+20 Texte, Audit, Workshops) fehlen in der Schätzung.`);
  return { ...cur, vergleich: vergleich(cur, prev), einstellungen: einst, fixkostenListe: fixkosten, anthropicGebuchtChf: await anthropicLesen(advisorId, month), vormonat: { month: vor, ergebnisChf: prev.ergebnisChf } };
}

// ───────── Export ─────────
function zeilenFuerExport(b) {
  const r = [];
  const z = (a, bb, c, d) => r.push([a, bb == null ? '' : bb, c == null ? '' : c, d == null ? '' : d]);
  z('Finanzaufstellung ' + b.month, b.schaetzung ? 'Schätzung, nicht aus Stripe' : 'Quelle Stripe');
  z('');
  z('EINNAHMEN', 'Anzahl', 'Klienten', 'CHF');
  for (const g of b.einnahmen.gruppen) {
    z(g.label);
    for (const l of g.zeilen) z('  ' + l.label, l.anzahl, l.klienten, l.betragChf.toFixed(2));
    z('Summe ' + g.label, '', '', g.summeChf.toFixed(2));
  }
  if (b.einnahmen.rueckerstattungenChf !== 0) z('Rückerstattungen', '', '', b.einnahmen.rueckerstattungenChf.toFixed(2));
  z('Summe Einnahmen', '', '', b.einnahmen.summeChf.toFixed(2));
  z('');
  z('KOSTEN', '', '', 'CHF');
  const ki = b.kosten.ki;
  z('KI-Kosten (Anthropic)' + (ki.mitGebuchtemWert ? ', gebuchte Rechnung' : ', berechnet'), '', '', ki.verwendetChf.toFixed(2));
  if (ki.mitGebuchtemWert) z('  davon berechnet aus dem Nutzungsprotokoll', '', '', ki.berechnetChf.toFixed(2));
  z('Stripe-Gebühren' + (b.kosten.stripeGebuehren.geschaetzt ? ' (Schätzung)' : ''), '', '', b.kosten.stripeGebuehren.betragChf.toFixed(2));
  for (const p of b.kosten.variable.posten) z('Variable Kosten: ' + p.name, '', '', p.betragChf.toFixed(2));
  for (const p of b.kosten.fix.posten) z('Fixkosten: ' + p.name, '', '', p.betragChf.toFixed(2));
  z('Summe Kosten', '', '', b.kosten.summeChf.toFixed(2));
  z('');
  z('Ergebnis des Monats', '', '', b.ergebnisChf.toFixed(2));
  z('Marge in Prozent', '', '', b.margeProzent == null ? '' : b.margeProzent.toFixed(1));
  z('KI-Kosten in Prozent des Umsatzes', '', '', b.kiProzentVomUmsatz == null ? '' : b.kiProzentVomUmsatz.toFixed(1));
  if (b.rueckstellung.prozent > 0) z(`Information: Rückstellung Steuern und Sozialversicherung (${b.rueckstellung.prozent} Prozent)`, '', '', b.rueckstellung.betragChf.toFixed(2));
  z('Wiederkehrender Monatsumsatz (MRR)', '', '', b.kennzahlen.mrrChf.toFixed(2));
  z('Jahreswert (ARR)', '', '', b.kennzahlen.arrChf.toFixed(2));
  z('Zahlende Klienten', '', '', b.kennzahlen.zahlendeKlienten);
  z('');
  z('KLIENTEN', 'Einnahmen CHF', 'KI-Kosten CHF', 'Ergebnis CHF');
  for (const k of b.klienten) z(k.name, k.einnahmenChf.toFixed(2), k.kiKostenChf.toFixed(2), k.ergebnisChf.toFixed(2));
  z('');
  z('REGELN');
  for (const t of b.regeln) z(t);
  z(b.einnahmen.mwst.text);
  for (const t of b.hinweise) z('Hinweis: ' + t);
  return r;
}
function toCsv(b) {
  return '﻿' + zeilenFuerExport(b).map(r => r.map(csvCell).join(';')).join('\r\n');
}

async function toDocx(b) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel } = require('docx');
  const P = (t, o = {}) => new Paragraph({ spacing: { after: 80 }, alignment: o.right ? AlignmentType.RIGHT : undefined, children: [new TextRun({ text: String(t), bold: !!o.bold, size: o.size || 21 })] });
  const cell = (t, o = {}) => new TableCell({ width: { size: o.w || 25, type: WidthType.PERCENTAGE }, children: [P(t, o)] });
  const row = (cols, bold) => new TableRow({ children: cols.map((t, i) => cell(t, { bold, right: i > 0, w: i === 0 ? 55 : 15 })) });
  const tab = rows => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  const kids = [];
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `Finanzaufstellung ${b.month}` })] }));
  kids.push(P(b.schaetzung ? 'Schätzung, nicht aus Stripe' : 'Quelle: Stripe, Zeiterfassung und Nutzungsprotokoll'));
  kids.push(P(`Einnahmen ${chf(b.einnahmen.summeChf)}   Kosten ${chf(b.kosten.summeChf)}   Ergebnis ${chf(b.ergebnisChf)}`, { bold: true, size: 24 }));
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Einnahmen')] }));
  const er = [row(['Position', 'Anzahl', 'Klienten', 'CHF'], true)];
  for (const g of b.einnahmen.gruppen) {
    er.push(row([g.label, '', '', ''], true));
    for (const l of g.zeilen) er.push(row(['  ' + l.label, l.anzahl, l.klienten, chf(l.betragChf)]));
    er.push(row(['Summe ' + g.label, '', '', chf(g.summeChf)], true));
  }
  if (b.einnahmen.rueckerstattungenChf !== 0) er.push(row(['Rückerstattungen', '', '', chf(b.einnahmen.rueckerstattungenChf)]));
  er.push(row(['Summe Einnahmen', '', '', chf(b.einnahmen.summeChf)], true));
  kids.push(tab(er));
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Kosten')] }));
  const ki = b.kosten.ki;
  const kr = [row(['Position', '', '', 'CHF'], true),
    row(['KI-Kosten (Anthropic)' + (ki.mitGebuchtemWert ? ', gebuchte Rechnung' : ', berechnet'), '', '', chf(ki.verwendetChf)]),
    row(['Stripe-Gebühren' + (b.kosten.stripeGebuehren.geschaetzt ? ' (Schätzung)' : ''), '', '', chf(b.kosten.stripeGebuehren.betragChf)])];
  for (const p of b.kosten.variable.posten) kr.push(row(['Variable Kosten: ' + p.name, '', '', chf(p.betragChf)]));
  for (const p of b.kosten.fix.posten) kr.push(row(['Fixkosten: ' + p.name, '', '', chf(p.betragChf)]));
  kr.push(row(['Summe Kosten', '', '', chf(b.kosten.summeChf)], true));
  kr.push(row(['Ergebnis des Monats', '', '', chf(b.ergebnisChf)], true));
  kids.push(tab(kr));
  kids.push(P(`Marge ${b.margeProzent == null ? 'offen' : b.margeProzent.toFixed(1) + ' Prozent'}. KI-Kosten ${b.kiProzentVomUmsatz == null ? 'offen' : b.kiProzentVomUmsatz.toFixed(1) + ' Prozent'} des Umsatzes. MRR ${chf(b.kennzahlen.mrrChf)}, ARR ${chf(b.kennzahlen.arrChf)}, ${b.kennzahlen.zahlendeKlienten} zahlende Klienten.`));
  if (b.rueckstellung.prozent > 0) kids.push(P(`Information: Rückstellung Steuern und Sozialversicherung (${b.rueckstellung.prozent} Prozent) ${chf(b.rueckstellung.betragChf)}.`));
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Klienten')] }));
  const kl = [row(['Klient', 'Einnahmen', 'KI-Kosten', 'Ergebnis'], true)];
  for (const k of b.klienten) kl.push(row([k.name, chf(k.einnahmenChf), chf(k.kiKostenChf), chf(k.ergebnisChf)]));
  kids.push(tab(kl));
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Regeln und Hinweise')] }));
  [...b.regeln, b.einnahmen.mwst.text, ...b.hinweise].forEach(t => kids.push(P(t, { size: 19 })));
  const doc = new Document({ sections: [{ children: kids }] });
  return Packer.toBuffer(doc);
}

module.exports = {
  compute, vergleich, klassiere, bericht, toCsv, toDocx, chf, prevMonth, monthOfSec, fixkostenImMonat, leereCache, ladeStripe, normLadung,
  einstellungenLesen, einstellungenSpeichern, fixkostenListe, fixkostenNeu, fixkostenAendern, fixkostenLoeschen, anthropicSetzen, REGELN, KATS
};
