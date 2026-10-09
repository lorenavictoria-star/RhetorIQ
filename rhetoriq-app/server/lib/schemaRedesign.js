const { pool } = require('../db');

// Schema der neuen Funktionen (Onboarding-Entwürfe, Ablage, Zugriffsprotokoll,
// Auftrag an Beraterin). Rein additiv: nur CREATE TABLE IF NOT EXISTS und
// ADD COLUMN IF NOT EXISTS, nullable oder mit Default. Wird beim ersten Bedarf
// ausgeführt und danach gemerkt; bei einem Fehler darf es erneut versucht werden.
let ensured = null;

function ensureSchema() {
  if (ensured) return ensured;
  ensured = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_drafts (
        id SERIAL PRIMARY KEY,
        inquiry_id INTEGER,
        firma TEXT,
        kontakt TEXT,
        email TEXT,
        webseite TEXT,
        sektor TEXT,
        anrede TEXT DEFAULT 'sie',
        titel TEXT,
        workshop_datum TEXT,
        schritt INTEGER NOT NULL DEFAULT 0,
        module JSONB NOT NULL DEFAULT '[]',
        vorschlaege JSONB NOT NULL DEFAULT '{}',
        briefing JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'workshop_offen',
        client_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_files (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        draft_id INTEGER,
        folder TEXT NOT NULL DEFAULT 'unterlagen',
        name TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        data BYTEA,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_log (
        id SERIAL PRIMARY KEY,
        advisor_id INTEGER,
        client_id INTEGER,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS advisor_id INTEGER`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS instruction TEXT`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);
    // Lernvorschläge aus den Korrekturen der Beraterin (Vergleich KI-Text und gesendete Fassung)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS learning_suggestions (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        module_key TEXT NOT NULL,
        module_label TEXT,
        category TEXT NOT NULL,
        observation TEXT NOT NULL,
        example_before TEXT,
        example_after TEXT,
        occurrences INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'offen',
        source_review_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE learning_suggestions ADD COLUMN IF NOT EXISTS source TEXT`);
    await pool.query(`ALTER TABLE learning_suggestions ADD COLUMN IF NOT EXISTS weight TEXT DEFAULT 'normal'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS learning_suggestions_client_idx ON learning_suggestions (client_id, status)`);
    // Goldtexte: gesendete, von der Beraterin korrigierte Fassungen als Stilvorbild (je Klient und Textart)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS goldtexte (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        feedback_key TEXT NOT NULL,
        text TEXT NOT NULL,
        quelle_review_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS goldtexte_client_idx ON goldtexte (client_id, feedback_key, created_at DESC)`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_plan TEXT`);
    // Zeiterfassung: Minuten je Freigabe und inbegriffenes Monatskontingent je Klient
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS minutes INTEGER`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS time_logged_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS included_minutes INTEGER`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS extra_users INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS paket TEXT`);
    await pool.query(`ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS groesse JSONB`);
    // Kommunikationsprofil: Ausgangslage, Ziel und laufende Messungen je Klient
    await pool.query(`
      CREATE TABLE IF NOT EXISTS communication_profiles (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        scores JSONB,
        metrics JSONB,
        findings JSONB,
        text_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS communication_profiles_client_idx ON communication_profiles (client_id, kind, created_at DESC)`);
    // Kostenloser Stimm-Schnelltest der Landingpage (Lead-Magnet)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schnelltests (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        email TEXT NOT NULL,
        befunde JSONB,
        ergebnis TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS schnelltests_created_idx ON schnelltests (created_at DESC)`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS learned_at TIMESTAMPTZ`);
    // Quartalsreview (Business: ein Gespräch pro Quartal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quartalsreviews (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        quartal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'geplant',
        termin TEXT,
        notizen TEXT,
        erledigt_am TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS quartalsreviews_client_q_idx ON quartalsreviews (client_id, quartal)`);
    // Abo-Status direkt am Klienten (derselbe Befehl wie in routes/subscriptions.js), damit die Kundenliste ihn mitladen kann
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'`);
    // Hinweis auf KI-Unterstützung unter exportierten Texten (Standard: aus)
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ki_hinweis BOOLEAN NOT NULL DEFAULT FALSE`);
    // Betriebszustand (KI-Wächter, Hinweis von Hand, Reservekonto-Schalter)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_status (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // 10er-Karte Überarbeitungen (300 Minuten persönliche Bearbeitung, verfallen nicht) und Monatsabschluss
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ueberarbeitungskarten (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        minuten_gesamt INTEGER NOT NULL DEFAULT 300,
        minuten_verbraucht INTEGER NOT NULL DEFAULT 0,
        gekauft_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        stripe_ref TEXT
      )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ueberarbeitungskarten_ref_idx ON ueberarbeitungskarten (stripe_ref)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monatsabschluss (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        monat TEXT NOT NULL,
        karten_minuten INTEGER NOT NULL DEFAULT 0,
        abgeschlossen_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS monatsabschluss_client_monat_idx ON monatsabschluss (client_id, monat)`);
    // Indizes für die häufigsten Abfragen (Kundenliste, Verlauf, Nutzung)
    await pool.query(`CREATE INDEX IF NOT EXISTS analyses_client_created_idx ON analyses (client_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS analyses_advisor_created_idx ON analyses (advisor_id, created_at DESC)`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// Nur für Tests: erzwingt eine erneute Ausführung.
function resetEnsured() { ensured = null; }

module.exports = { ensureSchema, resetEnsured };
