// Ein Lernweg, zwei Quellen: Gelernte Sätze (client_feedback_learnings) tragen ihre Herkunft ("korrektur" aus den
// Korrekturen der Beraterin nach Bestätigung, "klient" aus den Rückmeldungen des Klienten), und Widersprüche
// zwischen gelernten Sätzen derselben Kategorie werden erkannt, damit die Beraterin wählen kann («Behalten» oder «Vergessen»).
// Alles lokal, ohne KI. Die Herkunft liegt additiv in satz_meta (JSONB, siehe lib/learnedMeta.js).
const { pool } = require('../db');
const { ensureMeta, sentences } = require('./learnedMeta');

const HERKUNFT = {
  korrektur: 'aus deiner Korrektur',
  klient: 'aus Rückmeldung des Klienten'
};

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const tokens = s => new Set((String(s || '').toLowerCase().match(/[a-zäöüéèàç]{3,}/g) || []));
function aehnlich(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0; x.forEach(w => { if (y.has(w)) n++; });
  return n / (x.size + y.size - n);
}

function metaOf(row) { return (row && row.satz_meta && typeof row.satz_meta === 'object') ? { ...row.satz_meta } : {}; }

// Vermerkt für einen oder alle Sätze einer Zeile die Herkunft. Vorhandene Herkunft bleibt, außer onlyText ist gesetzt.
async function markiereHerkunft(clientId, moduleKey, category, herkunft, onlyText) {
  await ensureMeta();
  const { rows } = await pool.query('SELECT summary, updated_at, satz_meta FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category]);
  if (!rows[0]) return;
  const meta = metaOf(rows[0]);
  let changed = false;
  for (const s of sentences(rows[0].summary)) {
    const k = norm(s);
    if (onlyText != null && k !== norm(onlyText)) continue;
    const cur = meta[k] || { at: new Date(rows[0].updated_at).toISOString(), count: 1 };
    if (onlyText == null && cur.herkunft) continue;
    meta[k] = { ...cur, herkunft };
    changed = true;
  }
  if (changed) await pool.query('UPDATE client_feedback_learnings SET satz_meta=$4 WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category, JSON.stringify(meta)]);
}

// Vor dem Neuschreiben einer Zeile durch die automatische Verdichtung: merkt sich die Sätze mit bekannter Herkunft.
async function vorMerken(clientId, moduleKey, category) {
  await ensureMeta();
  const { rows } = await pool.query('SELECT summary, satz_meta FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3', [clientId, moduleKey, category]);
  const meta = metaOf(rows[0]);
  const bekannt = [];
  for (const s of sentences(rows[0] && rows[0].summary)) { const h = meta[norm(s)] && meta[norm(s)].herkunft; if (h) bekannt.push({ text: s, herkunft: h }); }
  return { clientId, moduleKey, category, bekannt };
}
// Nach dem Neuschreiben: Sätze, die einem bekannten Satz ähneln, behalten dessen Herkunft, alle anderen bekommen die neue.
async function nachMerken(merk, herkunftNeu) {
  if (!merk) return;
  await ensureMeta();
  const { rows } = await pool.query('SELECT summary, updated_at, satz_meta FROM client_feedback_learnings WHERE client_id=$1 AND module_key=$2 AND category=$3', [merk.clientId, merk.moduleKey, merk.category]);
  if (!rows[0]) return;
  const meta = metaOf(rows[0]);
  for (const s of sentences(rows[0].summary)) {
    const k = norm(s);
    if (meta[k] && meta[k].herkunft) continue;
    const vorher = merk.bekannt.find(b => aehnlich(b.text, s) >= 0.6);
    meta[k] = { ...(meta[k] || { at: new Date(rows[0].updated_at).toISOString(), count: 1 }), herkunft: vorher ? vorher.herkunft : herkunftNeu };
  }
  await pool.query('UPDATE client_feedback_learnings SET satz_meta=$4 WHERE client_id=$1 AND module_key=$2 AND category=$3', [merk.clientId, merk.moduleKey, merk.category, JSON.stringify(meta)]);
}

// ── Widersprüche ──────────────────────────────────────────────────────────────
// Jedes Thema hat zwei Pole (a, b). Ein Satz steht auf Pol a, wenn ein Begriff aus a ohne Verneinung vorkommt (oder ein Begriff
// aus b mit Verneinung), und umgekehrt. Zwei Sätze derselben Zeile (Textart und Kategorie) widersprechen sich, wenn sie zum
// selben Thema auf entgegengesetzten Polen stehen.
const NEG = /\b(nicht|kein\w*|weniger|statt|ohne|nie|niemals|vermeid\w*|verzicht\w*|zu)\s+(?:\S+\s+){0,2}$/i;
const THEMEN = [
  { id: 'Textlänge', unterThema: s => !/s(ä|ae)tz|\bsatz\b/i.test(s), a: /\bk(ü|u)rz\w*|\bknapp\w*|\bpr(ä|ae)gnant\w*/i, b: /\bl(ä|a)nger\w*|\bausf(ü|u)hrlich\w*|\bdetailliert\w*|\blang\w*/i },
  { id: 'Satzlänge', unterThema: s => /s(ä|ae)tz|\bsatz\b/i.test(s), a: /\bk(ü|u)rz\w*|\bknapp\w*/i, b: /\bl(ä|a)nger\w*|\blang\w*|\bverschachtelt\w*/i },
  { id: 'Formalität', a: /\bformell\w*|\bf(ö|oe)rmlich\w*|\bseri(ö|oe)s\w*|\bgehoben\w*/i, b: /\blocker\w*|\binformell\w*|\bumgangssprach\w*|\bsalopp\w*|\bzwanglos\w*/i },
  { id: 'Anrede', a: /\b[Ss]iez\w*|\bSie-Form\b|\bper Sie\b|\bmit Sie\b|\bAnrede[^.]*\bSie\b/, b: /\b[Dd]uz\w*|\bDu-Form\b|\bper [Dd]u\b|\bmit [Dd]u\b|\bAnrede[^.]*\b[Dd]u\b/ },
  { id: 'Wärme', a: /\bw(ä|ae)rmer\w*|\bwarm\w*|\bherzlich\w*|\bpers(ö|oe)nlich\w*|\bnahbar\w*/i, b: /\bn(ü|ue)chtern\w*|\bdistanziert\w*|\bk(ü|ue)hl\w*|\bsachlich\w*|\bneutral\w*/i },
  { id: 'Direktheit', a: /\bdirekt\w*|\bgeradlinig\w*|\bauf den Punkt\b/i, b: /\bdiplomatisch\w*|\bindirekt\w*|\bzur(ü|ue)ckhaltend\w*|\bvorsichtig\w*|\bumschreib\w*/i },
  { id: 'Emojis', schalter: /\bemojis?\b/i },
  { id: 'Ausrufezeichen', schalter: /\bausrufezeichen\b/i },
  { id: 'Fachsprache', schalter: /\bfachsprache\b|\bfachbegriff\w*|\bfachw(ö|oe)rter\w*/i },
  { id: 'Anglizismen', schalter: /\banglizism\w*|\bfremdw(ö|oe)rter\w*|\benglische\w* (Begriffe|W(ö|oe)rter)/i },
  { id: 'Aufzählungen', schalter: /\baufz(ä|ae)hlung\w*|\bbullet\w*|\bstichpunkt\w*/i }
];

// Verneinung unmittelbar vor dem Fund
function verneint(text, index) { return NEG.test(text.slice(Math.max(0, index - 40), index)); }

// 'a', 'b' oder null (kein Bezug oder uneindeutig)
function pol(text, thema) {
  if (thema.unterThema && !thema.unterThema(text)) return null;
  const stimmen = new Set();
  if (thema.schalter) {
    const m = thema.schalter.exec(text);
    if (!m) return null;
    return verneint(text, m.index) ? 'b' : 'a';
  }
  for (const [pole, re] of [['a', thema.a], ['b', thema.b]]) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      const flip = verneint(text, m.index);
      stimmen.add(flip ? (pole === 'a' ? 'b' : 'a') : pole);
    }
  }
  if (stimmen.size !== 1) return null;
  return [...stimmen][0];
}

// items: [{zeile, module_key, category, text}]. Ergebnis: [{a, b, thema}] (Indizes in items)
function findeKonflikte(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const x = items[i], y = items[j];
      if (x.module_key !== y.module_key || x.category !== y.category) continue;
      for (const t of THEMEN) {
        const px = pol(x.text, t), py = pol(y.text, t);
        if (px && py && px !== py) { out.push({ a: i, b: j, thema: t.id }); break; }
      }
    }
  }
  return out;
}

// Ergänzt die Sätze der Zeilen um Herkunft und Konflikte. rows: Zeilen aus client_feedback_learnings (mit satz_meta),
// saetzeJeZeile: Ergebnis von listSentences je Zeile (gleiche Reihenfolge). Verändert die Sätze direkt.
function anreichern(rows, saetzeJeZeile) {
  const items = [];
  rows.forEach((r, ri) => {
    const meta = metaOf(r);
    saetzeJeZeile[ri].forEach((s, si) => {
      const m = meta[norm(s.text)] || {};
      s.herkunft = m.herkunft || null;
      s.herkunftText = m.herkunft ? HERKUNFT[m.herkunft] || null : null;
      s.konflikt = null;
      items.push({ ri, si, module_key: r.module_key, category: r.category, text: s.text });
    });
  });
  for (const k of findeKonflikte(items)) {
    const a = items[k.a], b = items[k.b];
    const sa = saetzeJeZeile[a.ri][a.si], sb = saetzeJeZeile[b.ri][b.si];
    (sa.konflikt = sa.konflikt || { thema: k.thema, mit: [] }).mit.push(sb.text);
    (sb.konflikt = sb.konflikt || { thema: k.thema, mit: [] }).mit.push(sa.text);
  }
  return saetzeJeZeile;
}

module.exports = { HERKUNFT, markiereHerkunft, vorMerken, nachMerken, findeKonflikte, anreichern, pol, THEMEN };
