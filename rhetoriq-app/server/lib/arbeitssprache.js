// Arbeitssprache eines Klienten (de oder en) und die Wahl des Regelwerks. Reine Funktionen.
// Englisch heisst: British English, Corporate-Stil (lib/promptRulesEn.js). Alles andere bleibt beim bisherigen deutschen Regelwerk.
const SPRACHEN = ['de', 'en'];

function istEnglisch(s) { return /^(en|eng|english|englisch)\b/i.test(String(s || '').trim()); }

// Ausgabesprache eines Auftrags: die im Auftrag gewählte Sprache gewinnt, sonst die Arbeitssprache des Klienten
function ausgabeSprache(data, clientRow) {
  const l = data && data.language;
  if (l && String(l).trim()) return istEnglisch(l) ? 'en' : 'de';
  return istEnglisch(clientRow && clientRow.arbeitssprache) ? 'en' : 'de';
}

function regeln(sprache) {
  if (sprache === 'en') {
    const r = require('./promptRulesEn');
    return { rules: r.GLOBAL_STYLE_RULES_EN, head: r.BRAND_VOICE_HEAD_EN, tail: r.BRAND_VOICE_TAIL_EN };
  }
  const r = require('./promptRules');
  return { rules: r.GLOBAL_STYLE_RULES, head: r.BRAND_VOICE_HEAD, tail: r.BRAND_VOICE_TAIL };
}

// Zeile des Klienten mit der Arbeitssprache. Fehlt die Spalte (ältere Datenbank), gilt Deutsch.
async function zeile(pool, clientId) {
  if (!clientId) return null;
  try {
    const { rows } = await pool.query('SELECT arbeitssprache FROM clients WHERE id=$1', [clientId]);
    return rows[0] || null;
  } catch { return null; }
}

// Zusatz für die Brand-Voice-Analyse eines englisch arbeitenden Klienten: Das Dokument entsteht auf Englisch, die maschinell gelesenen Marker bleiben.
const BRAND_VOICE_ENGLISCH = '\n\nOUTPUT LANGUAGE (overrides the language of the instructions above): This client works in English. Write the ENTIRE Brand Voice document in British English (-ise spellings, plain corporate style). Translate every section heading and label into English (for example AT A GLANCE, STEP 1 READING AND FIRST DIAGNOSIS, VOICE CHARACTER, TONE SCALES, LANGUAGE FEATURES, DO\'S AND DON\'TS, GUIDING SENTENCE). The rules about Swiss German spelling and the comma before "und" do not apply; use British English conventions instead, with no em dashes and no Markdown. These machine-read marker lines stay exactly as defined, with their German keywords: the first line KERN, the section headers DETAIL: title and DETAIL (Textarten: Webseite, LinkedIn): title (the title text itself is in English, the text types keep the German names Webseite, LinkedIn, Newsletter, Mail, Medien, Rede, Brief), and the final line Stilmittel erlaubt: ... (or Stilmittel erlaubt: keine). Example sentences in the document are written in English.';

function gueltig(s) { return SPRACHEN.includes(s) ? s : null; }

module.exports = { SPRACHEN, istEnglisch, ausgabeSprache, regeln, gueltig, zeile, BRAND_VOICE_ENGLISCH };
