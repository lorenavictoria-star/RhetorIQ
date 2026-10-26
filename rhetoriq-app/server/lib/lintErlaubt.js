// Stilmittel, die zur Marke eines Klienten gehören, hält die Brand Voice selbst fest (die Brand-Voice-Analyse legt die Zeile an,
// Grundlage ist der Workshop). Eine Zeile, Stilmittel durch Semikolon getrennt, Textarten in Klammern:
//   Stilmittel erlaubt: Dreierketten (Webseite, LinkedIn, Newsletter); Gegenüberstellungen (Webseite)
// Ohne Klammer gilt das Stilmittel für alle Textarten. Nur was dort steht, ist für diesen Klienten erlaubt.
// Harte Regeln (Gedankenstriche, ß, Markdown, falsche Anrede, Floskeln) gelten immer.
const cache = new Map();   // clientId -> { bis, regeln }
const TTL = 2 * 60 * 1000;

const ZUORDNUNG = [
  [/gegen(?:ü|ue)berstellung|nicht\s*x/i, 'gegenueberstellung'],
  [/f(?:ü|ue)llw(?:ö|oe)rt/i, 'fuellwort'],
  [/dreierkette|dreier/i, 'dreierkette']
];
const TEXTART = [
  [/webseite|website|web\b/i, 'website'], [/social media|instagram|facebook|tiktok|\breel/i, 'social'], [/linkedin|social/i, 'linkedin'], [/newsletter/i, 'newsletter'],
  [/mail/i, 'email'], [/presse|medien/i, 'press'], [/rede|auftritt/i, 'speech'], [/brief/i, 'brief']
];

// Ergebnis: Liste {art, textarten: Set|null} (null = alle Textarten)
function stilmittelRegeln(text) {
  const out = [];
  const m = /^[\s\-*#•]*\**\s*stilmittel\s+erlaubt\s*:\s*\**\s*(.+)$/gim;
  let x;
  while ((x = m.exec(String(text || '')))) {
    for (const teil of x[1].split(';')) {
      const art = (ZUORDNUNG.find(([re]) => re.test(teil.split('(')[0])) || [])[1];
      if (!art) continue;
      const k = /\(([^)]*)\)/.exec(teil);
      let arten = null;
      if (k) {
        arten = new Set();
        for (const w of k[1].split(/[,/]/)) { const t = (TEXTART.find(([re]) => re.test(w)) || [])[1]; if (t) arten.add(t); }
        if (!arten.size) arten = null;
      }
      out.push({ art, textarten: arten });
    }
  }
  return out;
}

// Für eine Textart (kann null sein): Menge der erlaubten Arten ('gegenueberstellung', 'fuellwort', 'dreierkette')
function erlaubtFuer(regeln, textart) {
  const set = new Set();
  for (const r of regeln || []) if (!r.textarten || (textart && r.textarten.has(textart))) set.add(r.art);
  return set;
}

// Kompatibel zu früheren Aufrufen und Tests: alle Stilmittel, ohne Textart
function stilmittelAusBrandVoice(text, textart) { return erlaubtFuer(stilmittelRegeln(text), textart || null); }

async function erlaubteMuster(pool, clientId, textart) {
  if (!clientId) return new Set();
  let c = cache.get(String(clientId));
  if (!c || c.bis <= Date.now()) {
    let regeln = [];
    try {
      const { rows } = await pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%'`, [clientId]);
      regeln = stilmittelRegeln(rows.map(r => r.content).join('\n'));
    } catch { regeln = []; }
    c = { bis: Date.now() + TTL, regeln };
    cache.set(String(clientId), c);
  }
  return erlaubtFuer(c.regeln, textart || null);
}

function leereCache() { cache.clear(); }

module.exports = { erlaubteMuster, stilmittelAusBrandVoice, stilmittelRegeln, erlaubtFuer, leereCache };
