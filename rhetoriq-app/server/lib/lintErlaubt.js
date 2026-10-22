// Stilmittel, die zur Marke eines Klienten gehören, hält die Brand Voice selbst fest, in einer Zeile:
//   Stilmittel erlaubt: Gegenüberstellungen, Dreierketten
// Nur was dort ausdrücklich steht, ist für diesen Klienten erlaubt (Gegenüberstellungen «nicht X, sondern Y», Füllwörter).
// Harte Regeln (Gedankenstriche, ß, Markdown, falsche Anrede, Floskeln) gelten immer.
const cache = new Map();   // clientId -> { bis, set }
const TTL = 2 * 60 * 1000;

const ZUORDNUNG = [
  [/gegen(?:ü|ue)berstellung|nicht\s*x/i, 'gegenueberstellung'],
  [/f(?:ü|ue)llw(?:ö|oe)rt/i, 'fuellwort']
];

function stilmittelAusBrandVoice(text) {
  const set = new Set();
  const m = /^\s*stilmittel\s+erlaubt\s*:\s*(.+)$/gim;
  let x;
  while ((x = m.exec(String(text || '')))) {
    for (const [re, art] of ZUORDNUNG) if (re.test(x[1])) set.add(art);
  }
  return set;
}

async function erlaubteMuster(pool, clientId) {
  if (!clientId) return new Set();
  const c = cache.get(String(clientId));
  if (c && c.bis > Date.now()) return c.set;
  let set = new Set();
  try {
    const { rows } = await pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type LIKE 'brand_voice%'`, [clientId]);
    set = stilmittelAusBrandVoice(rows.map(r => r.content).join('\n'));
  } catch { set = new Set(); }
  cache.set(String(clientId), { bis: Date.now() + TTL, set });
  return set;
}

function leereCache() { cache.clear(); }

module.exports = { erlaubteMuster, stilmittelAusBrandVoice, leereCache };
