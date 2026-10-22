// Stilmuster, die zur Brand Voice eines Klienten gehören, gelten für ihn nicht als Fehler.
// Harte Regeln (Gedankenstriche, ß, Markdown, falsche Anrede, Floskeln) gelten immer.
// Weiche Muster (Gegenüberstellung «nicht X, sondern Y», Füllwörter) sind für einen Klienten erlaubt,
// wenn sie in seinen eigenen Texten (Beispiele aus Onboarding, Daumen hoch, eigene Beispiele, Referenzdokument) mindestens zweimal vorkommen.
const lint = require('./lint');

const WEICH = ['gegenueberstellung', 'fuellwort'];
const cache = new Map();   // clientId -> { bis, set }
const TTL = 5 * 60 * 1000;

function musterAusTexten(texte) {
  const gefunden = new Set();
  const alles = (texte || []).filter(Boolean).join('\n\n');
  if (!alles) return gefunden;
  const zaehler = {};
  for (const h of lint.lintText(alles, { sprache: 'de' })) if (WEICH.includes(h.art)) zaehler[h.art] = (zaehler[h.art] || 0) + 1;
  for (const k of Object.keys(zaehler)) if (zaehler[k] >= 2) gefunden.add(k);
  return gefunden;
}

async function erlaubteMuster(pool, clientId) {
  if (!clientId) return new Set();
  const c = cache.get(String(clientId));
  if (c && c.bis > Date.now()) return c.set;
  let set = new Set();
  try {
    const ex = await pool.query(
      `SELECT output_text FROM module_examples WHERE source_client_id=$1 AND auto_generated=false AND COALESCE(status,'active')='active' ORDER BY created_at DESC LIMIT 40`, [clientId]);
    const ref = await pool.query(`SELECT content FROM company_memory WHERE client_id=$1 AND memory_type='structural_reference'`, [clientId]);
    set = musterAusTexten([...ex.rows.map(r => r.output_text), ...ref.rows.map(r => r.content)]);
  } catch { set = new Set(); }
  cache.set(String(clientId), { bis: Date.now() + TTL, set });
  return set;
}

function leereCache() { cache.clear(); }

module.exports = { erlaubteMuster, musterAusTexten, leereCache, WEICH };
