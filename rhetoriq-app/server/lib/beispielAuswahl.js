// Themenbezogene Auswahl der Beispiele (Strukturvorlagen und Stimme) pro Modul und Klient. Läuft ohne KI.
//
// Kandidaten sind nur Beispiele, die bereits die Kliententrennung (exampleScope) und die Freigabe bestanden haben:
// Modul stimmt, von Hand angelegt oder per Daumen hoch / bestätigt (nicht automatisch gespeichert), Bewertung 3 oder höher,
// Status aktiv. Aus diesen werden die 2 bis 3 inhaltlich passendsten für den aktuellen Auftrag gewählt.
//
// FORMEL
//   Relevanz  rel = Summe über die Suchbegriffe t von IDF(t) x Treffer(t), geteilt durch die Summe der IDF(t) (Wert 0 bis 1).
//                   Suchbegriffe: Wortstämme der Eingabefelder des Auftrags ohne Stoppwörter.
//                   IDF(t) = ln(1 + N / (1 + df(t))) über die N Kandidaten; seltene Wörter zählen mehr.
//                   Treffer(t) = 1,0 wenn t in der Bezeichnung des Beispiels steht, 0,6 wenn nur im Text (Eingabe oder Aufbau).
//   Gewicht   w = (1 + 0,1 x (Bewertung - 3)) x EIGEN x TILE x HAND
//                   Bewertung 3 bis 5 ergibt 1,0 bis 1,2. Die Bewertung kann die Relevanz also um höchstens 20 Prozent
//                   verschieben (Gewichtsgrenzwert). Ein Beispiel mit Bewertung 3 schlägt eines mit Bewertung 5 nur, wenn seine
//                   Relevanz mehr als das 1,2-Fache beträgt.
//                   EIGEN = 1,15, wenn das Beispiel aus den Texten dieses Klienten stammt (trifft seine Stimme besser).
//                   TILE  = 1,1 bei gleicher Textart (zum Beispiel E-Mail), 0,85 bei anderer Textart, sonst 1.
//                   HAND  = 1,1 für von Hand abgelegte oder bestätigte Beispiele (Vorrang vor Daumen-hoch-Beispielen).
//   Punktzahl s = rel x w. Ein Beispiel zählt als passend ab rel >= MIN_REL (0,12).
//   Gleichstand: höhere Bewertung, dann neueres Beispiel.
//   Vielfalt: Von absteigend sortierten Treffern wird ein Beispiel übersprungen, wenn eines mit gleicher Bezeichnung
//   bereits gewählt ist oder die Wortüberlappung (Jaccard auf Wortstämmen) mit einem gewählten mindestens 0,6 beträgt.
//   Ergebnis: bis zu MAX_BEISPIELE (3) Beispiele. Ist keines passend, gilt das bisherige Verhalten (Reihenfolge der
//   Abfrage: Branche, Bewertung, Datum).
// Gesamtlänge: höchstens MAX_AUSGABE_JE (1200) Zeichen Aufbau je Beispiel und MAX_AUSGABE_GESAMT (3000) insgesamt.
// Die Beispiele stehen im dynamischen Teil des Systemtexts, der gecachte Teil (Brand Voice) bleibt unverändert.
// Grenzen je Klient: 5 Beispiele je Bezeichnung und 30 je Modul. Handbeispiele werden nie automatisch gelöscht;
// nur Daumen-hoch-Beispiele werden bei Erreichen der Grenze ersetzt (schwächstes und ältestes zuerst).

const { scopeSql } = require('./exampleScope');

const MAX_BEISPIELE = 3;
const MIN_REL = 0.12;
const EIGEN = 1.15;
const HAND = 1.1;
const TILE_GLEICH = 1.1;
const TILE_ANDERS = 0.85;
const TREFFER_TEXT = 0.6;
const AEHNLICH = 0.6;
const MAX_AUSGABE_JE = 1200;
const MAX_AUSGABE_GESAMT = 3000;
const MAX_EINGABE_JE = 400;
const MAX_KANDIDATEN = 60;
const MAX_PRO_MODUL = 30;
const MAX_PRO_BEZEICHNUNG = 5;
const MAX_BEZEICHNUNG = 60;
const MIN_LAENGE_BEISPIEL = 200;

const STOP = new Set(('aber alle allem allen aller alles also auch auf aus bei beim bin bis bist dabei dafuer dagegen daher dann das dass dein deine dem den der des dessen die dies diese diesem diesen dieser dieses doch dort durch ein eine einem einen einer eines einfach er es etwa euch euer eure fuer gegen gibt hab habe haben hat hatte hier hin hinter ich ihr ihre ihrem ihren ihrer im in indem ist ja jede jedem jeden jeder jedes jetzt kann kannst koennen koennte man mehr mein meine mit muss nach nicht noch nun nur ob oder ohne sehr sein seine seinem seinen seiner sich sie sind so sollen sollte soll ueber um und uns unser unsere unter vom von vor war waren was weil wenn wer werden wie wir wird wirst wo wollen wollte wuerde zu zum zur zwischen the and for with that this from your you are our will have has not but all can text schreibe schreiben bitte mal gerne')
  .split(/\s+/));
// Felder des Auftrags, die keine Aussage über das Thema machen
const KEIN_THEMA = new Set(['tile', 'lang', 'language', 'sprache', 'tone', 'ton', 'length', 'laenge', 'länge', 'intensity', 'format']);
const TILE_NAME = { linkedin: 'LinkedIn-Beitrag', newsletter: 'Newsletter', email: 'E-Mail', speech: 'Rede', press: 'Medienmitteilung', website: 'Webtext', brief: 'Brief', custom: 'Eigener Text' };

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
}
// Wortstamm grob: auf 6 Zeichen kürzen, damit Beugungen (Einladung, Einladungen, einladen) zusammenfallen
function tokens(text) {
  const out = [];
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w.length > 6 ? w.slice(0, 6) : w);
  }
  return out;
}

// Eingabefelder des Auftrags als Suchtext (nur Textfelder mit Inhalt, ohne Formatangaben)
function eingabeText(data) {
  if (typeof data === 'string') return data;
  return Object.entries(data || {})
    .filter(([k, v]) => typeof v === 'string' && v.trim().length > 2 && !KEIN_THEMA.has(String(k).toLowerCase()))
    .map(([, v]) => v).join('\n');
}

function kuerzen(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (p > max * 0.6 ? cut.slice(0, p + 1) : cut).trim() + ' [...]';
}

// Bezeichnung bereinigen: eine Zeile, höchstens 60 Zeichen, leer ergibt null
function bezeichnung(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAX_BEZEICHNUNG ? t.slice(0, MAX_BEZEICHNUNG - 1).replace(/\s+\S*$/, '').trim() + '…' : t;
}

// Bezeichnung für ein Daumen-hoch-Beispiel aus dem Auftrag: Betreff oder Thema, sonst Textart, sonst Modulname. Ohne KI.
function bezeichnungAusAuftrag(data, tile, modulName) {
  for (const k of ['subject', 'betreff', 'topic', 'thema', 'title', 'titel', 'occasion', 'anlass']) {
    const v = data && typeof data[k] === 'string' ? data[k].trim() : '';
    if (v.length >= 3) return bezeichnung(v.split('\n')[0]);
  }
  return bezeichnung(TILE_NAME[tile] || modulName);
}

// Berechnet Relevanz und Punktzahl jedes Kandidaten. Rein, ohne Datenbank.
function bewerte(kandidaten, { data, tile, klientId }) {
  const suche = [...new Set(tokens(eingabeText(data)))];
  const labels = kandidaten.map(k => new Set(tokens(k.label || '')));
  const docs = kandidaten.map((k, i) => new Set([...labels[i], ...tokens(String(k.input_text || '') + '\n' + String(k.output_text || '').slice(0, 2500))]));
  const N = kandidaten.length;
  const idf = new Map();
  for (const t of suche) {
    const df = docs.filter(d => d.has(t)).length;
    idf.set(t, Math.log(1 + N / (1 + df)));
  }
  const total = suche.reduce((a, t) => a + idf.get(t), 0);
  return kandidaten.map((k, i) => {
    const hit = suche.reduce((a, t) => a + (labels[i].has(t) ? idf.get(t) : docs[i].has(t) ? idf.get(t) * TREFFER_TEXT : 0), 0);
    const rel = total > 0 ? hit / total : 0;
    const bew = Math.min(5, Math.max(1, Number(k.rating) || 3));
    let w = 1 + 0.1 * (bew - 3);
    if (klientId != null && k.source_client_id != null && Number(k.source_client_id) === Number(klientId)) w *= EIGEN;
    if (tile && k.tile) w *= (k.tile === tile ? TILE_GLEICH : TILE_ANDERS);
    if (k.origin && k.origin !== 'thumbs') w *= HAND;
    return { k, rel, gewicht: w, punkte: rel * w, index: i, doc: docs[i] };
  });
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

// Wählt aus den Kandidaten (in Reihenfolge des bisherigen Verhaltens) die passendsten. Gibt {beispiele, grund} zurück.
function waehle(kandidaten, opt = {}) {
  const max = opt.max || MAX_BEISPIELE;
  const bew = bewerte(kandidaten, opt);
  const passend = bew.filter(b => b.rel >= MIN_REL).sort((a, b) =>
    (b.punkte - a.punkte) || ((b.k.rating || 0) - (a.k.rating || 0)) || (new Date(b.k.created_at || 0) - new Date(a.k.created_at || 0)) || (a.index - b.index));
  let gew, grund;
  if (passend.length) {
    gew = [];
    const gewaehlt = [];
    for (const b of passend) {
      if (gew.length >= max) break;
      const l = b.k.label ? norm(b.k.label).trim() : '';
      if (gewaehlt.some(g => (l && g.label === l) || jaccard(g.doc, b.doc) >= AEHNLICH)) continue;
      gewaehlt.push({ label: l, doc: b.doc });
      gew.push(b.k);
    }
    grund = 'passung';
  } else { gew = kandidaten.slice(0, max); grund = kandidaten.length ? 'rueckfall' : 'keine'; }
  // Gesamtlänge begrenzen
  let rest = MAX_AUSGABE_GESAMT;
  const beispiele = [];
  for (const k of gew) {
    if (rest < 300 && beispiele.length) break;
    const out = kuerzen(k.output_text, Math.min(MAX_AUSGABE_JE, rest));
    rest -= out.length;
    beispiele.push({ ...k, input_text: kuerzen(k.input_text, MAX_EINGABE_JE), output_text: out });
  }
  return { beispiele, grund, bewertung: bew };
}

// Lädt die berechtigten Kandidaten (Kliententrennung per scopeSql) und wählt aus.
async function ladeBeispiele(pool, { advisorId, module, industry, clientId, data }) {
  const { rows } = await pool.query(
    `SELECT id, label, input_text, output_text, industry_tag, rating, source_client_id, tile, origin, created_at FROM module_examples
     WHERE advisor_id=$1 AND module_key=$2
       AND auto_generated = false AND rating >= 3 AND COALESCE(status,'active')='active'
       AND ${scopeSql(4)}
       AND (industry_tag IS NULL OR $3::text IS NULL OR lower(industry_tag)=lower($3))
     ORDER BY
       CASE WHEN $3::text IS NOT NULL AND lower(industry_tag)=lower($3) THEN 0 ELSE 1 END,
       rating DESC, created_at DESC
     LIMIT ${MAX_KANDIDATEN}`,
    [advisorId, module, industry || null, clientId || null]
  );
  const tile = data && typeof data.tile === 'string' ? data.tile : null;
  return waehle(rows, { data, tile, klientId: clientId || null }).beispiele;
}

// Textart aus dem Feedback-Schlüssel («text-gen-email» ergibt «email»)
function tileAusSchluessel(feedbackKey, module) {
  const k = String(feedbackKey || '');
  return module && k.startsWith(module + '-') ? k.slice(module.length + 1) : null;
}

function eingabeFuerBeispiel(data, fallback) {
  const t = Object.entries(data || {})
    .filter(([, v]) => v && typeof v === 'string' && v.length > 2)
    .map(([k, v]) => `${k}: ${v}`).join('\n');
  return t || fallback || 'Eingabe';
}

// Schafft Platz für ein neues Beispiel dieses Klienten. Löscht nur Daumen-hoch-Beispiele (schwächstes, dann ältestes).
// Gibt null zurück, wenn Platz ist (gegebenenfalls nach Ersetzen), sonst {grenze:'modul'|'bezeichnung', n}.
// ausser: ID eines Beispiels, das nicht mitzählt (beim Ändern einer Bezeichnung).
async function platzSchaffen(pool, { advisorId, clientId, module, label, ausser }) {
  const base = `FROM module_examples WHERE advisor_id=$1 AND source_client_id=$2 AND module_key=$3 AND auto_generated=false AND COALESCE(status,'active')='active' AND id<>$4`;
  const args = [advisorId, clientId, module, ausser || 0];
  const lab = label ? norm(label).trim() : null;
  const pruefen = async (scope) => {
    const extra = scope === 'bezeichnung' ? ' AND lower(label)=lower($5)' : '';
    const a = scope === 'bezeichnung' ? [...args, label] : args;
    const max = scope === 'bezeichnung' ? MAX_PRO_BEZEICHNUNG : MAX_PRO_MODUL;
    for (;;) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n ${base}${extra}`, a);
      if (rows[0].n < max) return null;
      const { rows: d } = await pool.query(`SELECT id ${base}${extra} AND origin='thumbs' ORDER BY rating ASC, created_at ASC, id ASC LIMIT 1`, a);
      if (!d[0]) return { grenze: scope, n: rows[0].n };
      await pool.query('DELETE FROM module_examples WHERE id=$1', [d[0].id]);
    }
  };
  if (lab) { const r = await pruefen('bezeichnung'); if (r) return r; }
  return pruefen('modul');
}

function grenzeText(g) {
  return `Für ${g.grenze === 'modul' ? 'dieses Modul' : 'diese Bezeichnung'} sind ${g.n} Beispiele abgelegt. Löschen Sie eines, um ein neues hinzuzufügen.`;
}

// Daumen hoch: Text wird Beispiel dieses Klienten (Herkunft «thumbs»). Daumen runter senkt es oder entfernt es.
// Gibt zurück, was geschehen ist (für Tests und Protokoll).
async function daumenAufBeispiel(pool, { analysis, rating }) {
  const { advisor_id: advisorId, client_id: clientId, module, result } = analysis;
  if (!advisorId || !clientId || !module) return 'uebersprungen';
  const text = String(result || '');
  const { rows: vorhanden } = await pool.query(
    `SELECT id, rating FROM module_examples WHERE advisor_id=$1 AND source_client_id=$2 AND module_key=$3 AND origin='thumbs'
       AND (analysis_id=$4 OR output_text=$5)`,
    [advisorId, clientId, module, analysis.id, text]);
  if (Number(rating) === -1) {
    let aktion = 'nichts';
    for (const r of vorhanden) {
      if (r.rating - 1 < 3) { await pool.query('DELETE FROM module_examples WHERE id=$1', [r.id]); aktion = 'entfernt'; }
      else { await pool.query('UPDATE module_examples SET rating=$2 WHERE id=$1', [r.id, r.rating - 1]); aktion = 'gesenkt'; }
    }
    return aktion;
  }
  if (vorhanden.length) {
    // gleicher Text noch einmal bestätigt: sicherstellen, dass er mit mindestens 3 wirkt, ohne Doppelung
    await pool.query('UPDATE module_examples SET rating=GREATEST(rating,3) WHERE id=$1', [vorhanden[0].id]);
    return 'vorhanden';
  }
  if (text.length <= MIN_LAENGE_BEISPIEL) return 'zu_kurz';
  const tile = tileAusSchluessel(analysis.feedback_key, module);
  const label = bezeichnungAusAuftrag(analysis.input_data, tile, analysis.module_label || module);
  // Bei voller Grenze ersetzt das neue Beispiel das schwächste und älteste Daumen-hoch-Beispiel; Handbeispiele bleiben unangetastet
  if (await platzSchaffen(pool, { advisorId, clientId, module, label })) return 'voll';
  await pool.query(
    `INSERT INTO module_examples (advisor_id, module_key, tile, label, input_text, output_text, rating, auto_generated, source_client_id, is_cross_client_shareable, origin, status, analysis_id)
     VALUES ($1,$2,$3,$4,$5,$6,3,false,$7,false,'thumbs','active',$8)`,
    [advisorId, module, tile, label, eingabeFuerBeispiel(analysis.input_data, analysis.module_label || module), text, clientId, analysis.id]);
  return 'angelegt';
}

// Ob ein Beispiel beim nächsten Text für das Modul zur Auswahl steht (für die Anzeige). Spiegelt die Abfrage in ladeBeispiele.
function zurAuswahl(row, klientId) {
  if (row.auto_generated) return { ja: false, grund: 'automatisch' };
  if ((row.status || 'active') !== 'active') return { ja: false, grund: 'unbestaetigt' };
  if ((Number(row.rating) || 0) < 3) return { ja: false, grund: 'bewertung' };
  const frei = row.is_cross_client_shareable === true || (klientId != null && Number(row.source_client_id) === Number(klientId));
  if (!frei) return { ja: false, grund: 'anderer_klient' };
  return { ja: true, grund: null };
}

module.exports = {
  tokens, eingabeText, bewerte, waehle, ladeBeispiele, daumenAufBeispiel, zurAuswahl, tileAusSchluessel, kuerzen,
  bezeichnung, bezeichnungAusAuftrag, platzSchaffen, grenzeText, jaccard,
  MAX_BEISPIELE, MIN_REL, EIGEN, HAND, TILE_GLEICH, TILE_ANDERS, MAX_AUSGABE_JE, MAX_AUSGABE_GESAMT,
  MAX_PRO_MODUL, MAX_PRO_BEZEICHNUNG, MAX_BEZEICHNUNG, MIN_LAENGE_BEISPIEL, AEHNLICH
};
