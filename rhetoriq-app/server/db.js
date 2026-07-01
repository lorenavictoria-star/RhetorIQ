const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'advisor',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      advisor_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      industry TEXT,
      contact TEXT,
      slug TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id),
      advisor_id INTEGER REFERENCES users(id),
      module TEXT NOT NULL,
      module_label TEXT,
      input_data JSONB,
      result TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS people_profiles (
      id SERIAL PRIMARY KEY,
      person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
      profile_type TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, profile_type)
    );

    CREATE TABLE IF NOT EXISTS company_memory (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(client_id, memory_type)
    );

    CREATE TABLE IF NOT EXISTS review_requests (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      module_label TEXT,
      original_text TEXT NOT NULL,
      edited_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS content_subscriptions (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      frequency TEXT NOT NULL,
      topic_hint TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_sent_at TIMESTAMPTZ,
      UNIQUE(client_id, format)
    );
  `);
}

module.exports = { pool, init };
