// Themenplan und Newsletter-Entwurf (Zusatzprodukt, CHF 150 pro Monat): einmal pro Klient und Monat.
// Nutzt dieselben Bausteine wie die Textproduktion (Brand Voice, Regelwerk, gelernte Vorlieben, Datum) über aiProvider.
// Das Ergebnis geht als Freigabe an die Beraterin (review_requests, Status pending). Der Klient sieht es erst nach ihrer Freigabe.
// Hinweis: Die Anthropic-Batch-Schnittstelle fehlt in aiProvider. Ein Batch würde 50 Prozent sparen, ginge aber nur für Läufe ohne Eile.
const { pool } = require('../db');
const aiProvider = require('./aiProvider');
const meter = require('./meter');
const { ensureSchema } = require('./schemaRedesign');
const { GLOBAL_STYLE_RULES, BRAND_VOICE_HEAD, BRAND_VOICE_TAIL } = require('./promptRules');
const { heuteBlock, datumZuerich } = require('./heute');

const CAP_USD = parseFloat(process.env.THEMENPLAN_CAP_USD) || 0.50;   // Obergrenze je Klient und Lauf
const PLAN_LABEL = 'Themenplan';
const NEWSLETTER_LABEL = 'Newsletter-Entwurf';
const INSTRUCTION = 'Monatlicher Themenplan, Durchsicht ca. 30 Minuten';
const INSTRUCTION_NL = 'Monatlicher Themenplan, Newsletter-Entwurf zum wichtigsten Thema';
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function clean(t, max) {
  return String(t || '').replace(/[​-‍‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max);
}
// Gedankenstriche und ß sind in den Texten tabu, auch wenn das Modell sie liefert
function schweiz(t) {
  return String(t || '').replace(/\s[–—]\s/g, ', ').replace(/[–—]/g, '-').replace(/ß/g, 'ss');
}

function easter(y) {   // Gaussche Osterformel (Gregorianisch)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, mo - 1, da));
}
const plusDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Feiertage und Anlässe der Schweiz im Monat (month 1 bis 12)
function feiertage(y, month) {
  const e = easter(y);
  const list = [
    [new Date(Date.UTC(y, 0, 1)), 'Neujahr'], [new Date(Date.UTC(y, 0, 2)), 'Berchtoldstag (in manchen Kantonen)'],
    [plusDays(e, -2), 'Karfreitag'], [e, 'Ostersonntag'], [plusDays(e, 1), 'Ostermontag'],
    [new Date(Date.UTC(y, 4, 1)), 'Tag der Arbeit (in manchen Kantonen)'], [plusDays(e, 39), 'Auffahrt'],
    [plusDays(e, 49), 'Pfingstsonntag'], [plusDays(e, 50), 'Pfingstmontag'],
    [new Date(Date.UTC(y, 7, 1)), 'Bundesfeier'], [new Date(Date.UTC(y, 11, 24)), 'Heiligabend'],
    [new Date(Date.UTC(y, 11, 25)), 'Weihnachten'], [new Date(Date.UTC(y, 11, 26)), 'Stephanstag'], [new Date(Date.UTC(y, 11, 31)), 'Silvester'],
  ];
  return list.filter(([d]) => d.getUTCMonth() + 1 === month).map(([d, n]) => ({ tag: d.getUTCDate(), name: n }));
}
function jahreszeit(month) {
  return month === 12 || month <= 2 ? 'Winter' : month <= 5 ? 'Frühling' : month <= 8 ? 'Sommer' : 'Herbst';
}
function kalenderBlock(y, month) {
  const f = feiertage(y, month);
  return `KALENDER ${MONATE[month - 1].toUpperCase()} ${y} (Schweiz)\nJahreszeit: ${jahreszeit(month)}\nFeiertage und Anlässe: ${f.length ? f.map(x => `${x.tag}. ${x.name}`).join(', ') : 'keine gesetzlichen Feiertage'}`;
}

// Sammelt, was die Plattform über den Klienten weiss
async function kontext(clientId) {
  const q = async (sql, p) => (await pool.query(sql, p).catch(() => ({ rows: [] }))).rows;
  const [c] = await q('SELECT id, name, industry, contact, salutation FROM clients WHERE id=$1', [clientId]);
  if (!c) return null;
  const voice = await q(`SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%' ORDER BY updated_at DESC`, [clientId]);
  const facts = await q(`SELECT memory_type, content FROM company_memory WHERE client_id=$1 AND memory_type NOT LIKE 'brand_voice%' AND memory_type<>'structural_reference' ORDER BY updated_at DESC LIMIT 6`, [clientId]);
  const learned = await q('SELECT category, summary FROM client_feedback_learnings WHERE client_id=$1 ORDER BY category LIMIT 20', [clientId]);
  const texts = await q(`SELECT module_label, result FROM analyses WHERE client_id=$1 AND result IS NOT NULL ORDER BY created_at DESC LIMIT 8`, [clientId]);
  return { c, voice, facts, learned, texts };
}

function systemBlocks(k, y, month) {
  const blocks = [];
  if (k.voice.length) blocks.push({ type: 'text', text: BRAND_VOICE_HEAD + k.voice.map(m => `${m.memory_type.toUpperCase()}:\n${clean(m.content, 6000)}\n\n`).join('') + BRAND_VOICE_TAIL, cache_control: { type: 'ephemeral' } });
  let dyn = '';
  if (k.facts.length) dyn += '\n\nHINTERLEGTE FIRMENDATEN:\n' + k.facts.map(m => `- ${m.memory_type}: ${clean(m.content, 800)}`).join('\n');
  if (k.learned.length) dyn += '\n\nGELERNTE PRÄFERENZEN DIESES KLIENTEN (aus früherem Feedback):\n' + k.learned.map(r => `- ${r.category}: ${clean(r.summary, 300)}`).join('\n');
  dyn += '\n\n' + kalenderBlock(y, month) + heuteBlock();
  blocks.push({ type: 'text', text: dyn.trim() });
  blocks.push({ type: 'text', text: GLOBAL_STYLE_RULES });
  return blocks;
}

function planPrompt(k, y, month) {
  const recent = k.texts.length ? k.texts.map((t, i) => `${i + 1}. [${t.module_label || 'Text'}] ${clean(t.result, 350)}`).join('\n') : '(noch keine Texte)';
  return `Erstelle den Themenplan für ${MONATE[month - 1]} ${y} für den Klienten ${clean(k.c.name, 120)} (Branche: ${clean(k.c.industry, 120) || 'nicht angegeben'}).
Liefere 8 bis 10 Themen für Beiträge und Mitteilungen dieses Monats. Das wichtigste Thema steht an erster Stelle. Jedes Thema hat:
titel (kurz und konkret), anlass (warum jetzt: Jahreszeit, Feiertag, Branchenrhythmus oder Bezug zu bisherigen Texten), kernaussage (genau ein Satz), textart (eine von: LinkedIn-Beitrag, Newsletter, E-Mail, Medienmitteilung, Rede, Webseitentext), termin (Vorschlag als Datum im Format TT.MM.JJJJ, kein Feiertag und kein Wochenende).
Wiederhole kein Thema aus den letzten Texten. Erfinde keine Zahlen, Namen oder Ereignisse des Klienten, setze bei Bedarf eine Lücke in eckigen Klammern.
Antworte ausschliesslich mit gültigem JSON ohne weiteren Text im Format {"themen":[{"titel":"","anlass":"","kernaussage":"","textart":"","termin":""}]}.

LETZTE TEXTE DES KLIENTEN:
${recent}`;
}

function parsePlan(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const t = (Array.isArray(j.themen) ? j.themen : []).map(x => ({
      titel: schweiz(clean(x.titel, 160)), anlass: schweiz(clean(x.anlass, 300)), kernaussage: schweiz(clean(x.kernaussage, 300)),
      textart: schweiz(clean(x.textart, 60)), termin: clean(x.termin, 30)
    })).filter(x => x.titel);
    return t.length ? t : null;
  } catch { return null; }
}

function planToText(themen, y, month, rohtext) {
  if (!themen) return schweiz(clean(rohtext, 12000));
  return `THEMENPLAN ${MONATE[month - 1].toUpperCase()} ${y}\n\n` + themen.map((t, i) =>
    `${i + 1}. ${t.titel}\nAnlass: ${t.anlass}\nKernaussage: ${t.kernaussage}\nTextart: ${t.textart}\nTermin: ${t.termin}`).join('\n\n');
}

async function callWith(k, y, month, user, maxTokens, client, advisorId) {
  const resp = await aiProvider.generateText({
    system: systemBlocks(k, y, month), messages: [{ role: 'user', content: user }], maxTokens, model: aiProvider.resolveModelId('sonnet'), temperature: 0.7,
    meter: { module: 'themenplan', clientId: client.id, advisorId: advisorId || null }
  });
  const cost = meter.costUsd({ model: resp.model || aiProvider.resolveModelId('sonnet'), inputTokens: resp.inputTokens || 0, outputTokens: resp.outputTokens || 0,
    cacheCreationTokens: resp.cacheCreationTokens || 0, cacheReadTokens: resp.cacheReadTokens || 0 });
  return { text: resp.text, cost };
}

// Ein Lauf für einen Klienten. Gibt { status, ... } zurück. status: fertig | uebersprungen | abgebrochen | fehler
async function runForClient(clientId, opts = {}) {
  await ensureSchema();
  const cap = opts.capUsd || CAP_USD;
  const now = opts.now || new Date();
  const { y, m: month } = datumZuerich(now);
  const monat = `${y}-${String(month).padStart(2, '0')}`;
  const k = await kontext(clientId);
  if (!k) return { status: 'fehler', grund: 'Klient nicht gefunden.' };
  // Einmal pro Klient und Monat: der eindeutige Index reserviert den Lauf. Nur Fehler und Abbrüche dürfen wiederholt werden.
  const prev = (await pool.query('SELECT id, status FROM themenplan_laeufe WHERE client_id=$1 AND monat=$2', [clientId, monat])).rows[0];
  if (prev && !['fehler', 'abgebrochen'].includes(prev.status)) return { status: 'uebersprungen', grund: prev.status === 'fertig' ? 'Für diesen Monat gibt es schon einen Themenplan.' : 'Der Lauf ist im Gang.', monat };
  let lauf = prev ? prev.id : null;
  if (prev) {
    const up = await pool.query(`UPDATE themenplan_laeufe SET status='laeuft', kosten_usd=0, updated_at=NOW() WHERE id=$1 AND status IN ('fehler','abgebrochen') RETURNING id`, [prev.id]);
    if (!up.rows.length) return { status: 'uebersprungen', grund: 'Der Lauf ist im Gang.', monat };
  } else {
    try { lauf = (await pool.query(`INSERT INTO themenplan_laeufe (client_id, monat, status) VALUES ($1,$2,'laeuft') RETURNING id`, [clientId, monat])).rows[0].id; }
    catch { return { status: 'uebersprungen', grund: 'Der Lauf ist im Gang.', monat }; }
  }
  const finish = async (status, kosten, extra = {}) => {
    await pool.query('UPDATE themenplan_laeufe SET status=$1, kosten_usd=$2, updated_at=NOW() WHERE id=$3', [status, kosten, lauf]).catch(() => {});
    return { status, kosten, monat, ...extra };
  };
  let kosten = 0;
  try {
    const advisorId = (await pool.query('SELECT advisor_id FROM clients WHERE id=$1', [clientId])).rows[0]?.advisor_id || null;
    // Vorab: schon das Eingabevolumen allein darf die Obergrenze nicht sprengen (grobe Schätzung, 3.5 Zeichen je Token)
    const user1 = planPrompt(k, y, month);
    const estIn = (user1.length + k.voice.reduce((s, v) => s + clean(v.content, 6000).length, 0)) / 3.5;
    if (meter.costUsd({ model: aiProvider.resolveModelId('sonnet'), inputTokens: estIn, outputTokens: 2500 }) > cap) return await finish('abgebrochen', 0, { grund: 'Geschätzte Kosten über der Obergrenze.' });
    const p1 = await callWith(k, y, month, user1, 2500, k.c, advisorId);
    kosten += p1.cost;
    if (kosten > cap) return await finish('abgebrochen', kosten, { grund: 'Kostenobergrenze überschritten.' });
    const themen = parsePlan(p1.text);
    const planText = planToText(themen, y, month, p1.text);
    // Newsletter-Entwurf zum wichtigsten (ersten) Thema, nur wenn die Obergrenze noch Platz lässt
    const top = themen ? themen[0] : null;
    const user2 = `Schreibe einen Newsletter-Entwurf für ${clean(k.c.name, 120)} zum wichtigsten Thema des Monats ${MONATE[month - 1]} ${y}.
${top ? `Thema: ${top.titel}\nAnlass: ${top.anlass}\nKernaussage: ${top.kernaussage}` : `Thema: wähle das wichtigste Thema aus diesem Themenplan:\n${planText.slice(0, 3000)}`}
Aufbau: Betreffzeile (eine Zeile, nach dem Wort BETREFF:), Vorschautext in einem Satz (nach VORSCHAU:), dann der Text mit kurzer Einleitung, zwei bis drei Abschnitten und einem klaren Schluss mit einem nächsten Schritt für die Leserin. Länge etwa 250 bis 350 Wörter. Erfinde keine Zahlen, Namen oder Ereignisse, setze bei Bedarf eine Lücke in eckigen Klammern.`;
    let nlText = null;
    if (kosten + meter.costUsd({ model: aiProvider.resolveModelId('sonnet'), inputTokens: 4000, outputTokens: 1500 }) <= cap) {
      const p2 = await callWith(k, y, month, user2, 1500, k.c, advisorId);
      kosten += p2.cost;
      if (kosten > cap) return await finish('abgebrochen', kosten, { grund: 'Kostenobergrenze überschritten.' });
      nlText = schweiz(clean(p2.text, 12000));
    }
    const ins = `INSERT INTO review_requests (client_id, module_label, module_key, original_text, status, instruction) VALUES ($1,$2,'themenplan',$3,'pending',$4) RETURNING id`;
    const planRv = (await pool.query(ins, [clientId, PLAN_LABEL, planText, INSTRUCTION])).rows[0].id;
    const nlRv = nlText ? (await pool.query(ins, [clientId, NEWSLETTER_LABEL, nlText, INSTRUCTION_NL])).rows[0].id : null;
    return await finish('fertig', kosten, { reviewIds: [planRv, nlRv].filter(Boolean), themen: themen ? themen.length : 0 });
  } catch (e) {
    console.error('[themenplan] Klient', clientId, e.message);
    return await finish('fehler', kosten, { grund: e.message });
  }
}

module.exports = { runForClient, feiertage, kalenderBlock, jahreszeit, easter, parsePlan, schweiz, CAP_USD, INSTRUCTION, PLAN_LABEL, NEWSLETTER_LABEL };
