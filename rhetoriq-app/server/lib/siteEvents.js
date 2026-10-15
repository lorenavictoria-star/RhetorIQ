// Anonyme Besucherzähler für rhetoriq.ch: je Tag und Ereignis eine Zahl. Gespeichert werden weder Adressen noch Kennungen.
const LABELS = {
  view_home: 'Besuche Startseite',
  view_home_en: 'Besuche Startseite EN',
  view_preise: 'Besuche Preise',
  view_inhalt: 'Besuche Inhaltsseiten',
  cta_test_hero: 'Klick Stimmtest oben',
  cta_test_fuss: 'Klick Stimmtest unten',
  test_submit: 'Schnelltest abgeschickt',
  call_click: 'Klick Gespräch anfragen',
  wait_open: 'Klick Warteliste',
  gift_click: 'Klick Geschenk-PDF'
};
const NAMES = new Set(Object.keys(LABELS));

let ensured = false;
async function ensureTable(pool) {
  if (ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS site_events (
    day DATE NOT NULL DEFAULT CURRENT_DATE,
    name TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, name)
  )`);
  ensured = true;
}
const gueltig = (name) => typeof name === 'string' && NAMES.has(name);

async function record(pool, name) {
  if (!gueltig(name)) return false;
  await ensureTable(pool);
  await pool.query(
    `INSERT INTO site_events (day, name, n) VALUES (CURRENT_DATE, $1, 1)
     ON CONFLICT (day, name) DO UPDATE SET n = site_events.n + 1`, [name]);
  return true;
}
async function summary(pool, days) {
  await ensureTable(pool);
  const { rows } = await pool.query(
    `SELECT name, SUM(n)::int AS n FROM site_events WHERE day > CURRENT_DATE - $1::int GROUP BY name`, [days]);
  return Object.fromEntries(rows.map(r => [r.name, r.n]));
}
function reportLines(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = ['WEBSEITE (letzte 7 Tage, anonym gezählt):'];
  if (!total) return [...lines, '  Noch keine Zählung.'];
  for (const k of Object.keys(LABELS)) if (counts[k]) lines.push(`  ${LABELS[k]}: ${counts[k]}`);
  return lines;
}
module.exports = { LABELS, gueltig, record, summary, reportLines };
