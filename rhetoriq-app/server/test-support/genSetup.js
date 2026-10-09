// Zusätzliche Tabellen und Spalten, damit POST /api/analyze und /stream gegen pg-mem laufen (nur für Tests).
async function setupGenerate(H) {
  const q = (sql) => H.pool.query(sql).catch(() => {});
  await q(`ALTER TABLE analyses ADD COLUMN generated_by TEXT`);
  await q(`ALTER TABLE analyses ADD COLUMN had_brand_voice BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE clients ADD COLUMN monthly_token_limit BIGINT`);
  await q(`ALTER TABLE clients ADD COLUMN subscription_status TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS module_examples (id SERIAL PRIMARY KEY, advisor_id INTEGER, module_key TEXT, industry_tag TEXT, input_text TEXT, output_text TEXT, rating INTEGER DEFAULT 3, auto_generated BOOLEAN DEFAULT FALSE, client_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS company_memory (id SERIAL PRIMARY KEY, client_id INTEGER, memory_type TEXT, content TEXT, title TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS client_module_prompts (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT, instructions TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS client_feedback_learnings (id SERIAL PRIMARY KEY, client_id INTEGER, module_key TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, module_key, category))`);
  await q(`CREATE TABLE IF NOT EXISTS usage_topups (id SERIAL PRIMARY KEY, client_id INTEGER, tokens BIGINT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS generation_errors (id SERIAL PRIMARY KEY, client_id INTEGER, advisor_id INTEGER, module TEXT, error_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
}

// Systemtext aus den Aufrufen der KI-Attrappe zusammensetzen
function systemText(call) {
  const s = call.system;
  return Array.isArray(s) ? s.map(b => b.text).join('\n') : String(s || '');
}

module.exports = { setupGenerate, systemText };
