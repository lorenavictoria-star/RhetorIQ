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
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS instruction TEXT`);
    await pool.query(`ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

// Nur für Tests: erzwingt eine erneute Ausführung.
function resetEnsured() { ensured = null; }

module.exports = { ensureSchema, resetEnsured };
