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
    ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_client_id_fkey;
    ALTER TABLE analyses ADD CONSTRAINT analyses_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS capital_markets_enabled BOOLEAN DEFAULT FALSE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS hotel_enabled BOOLEAN DEFAULT FALSE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS enabled_modules TEXT[];

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

    CREATE TABLE IF NOT EXISTS client_module_prompts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      instructions TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(client_id, module_key)
    );

    CREATE TABLE IF NOT EXISTS client_users (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(client_id, email)
    );
    ALTER TABLE client_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE analyses ADD COLUMN IF NOT EXISTS generated_by TEXT;

    CREATE TABLE IF NOT EXISTS module_examples (
      id SERIAL PRIMARY KEY,
      advisor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      label TEXT,
      industry_tag TEXT,
      input_text TEXT NOT NULL,
      output_text TEXT NOT NULL,
      rating INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE module_examples ADD COLUMN IF NOT EXISTS industry_tag TEXT;
    ALTER TABLE module_examples ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT FALSE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS training_imported_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS invite_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      used_by INTEGER REFERENCES users(id),
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id SERIAL PRIMARY KEY,
      advisor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      module TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS usage_log_advisor_idx ON usage_log(advisor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_log_client_idx ON usage_log(client_id, created_at DESC);

    -- Task 10: Brand Voice version history
    CREATE TABLE IF NOT EXISTS company_memory_history (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      saved_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mem_history_client_idx ON company_memory_history(client_id, memory_type, saved_at DESC);

    -- Task 11: track whether brand voice was active at generation time
    ALTER TABLE analyses ADD COLUMN IF NOT EXISTS had_brand_voice BOOLEAN DEFAULT FALSE;

    -- Task 12: DSGVO — advisor confirms client was informed about Anthropic data processing
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS privacy_acknowledged_at TIMESTAMPTZ;

    -- Task 16: thumbs up/down per analysis
    ALTER TABLE analyses ADD COLUMN IF NOT EXISTS user_rating SMALLINT;

    -- Feedback keywords on rating, fed back into the client's per-module custom instructions
    ALTER TABLE analyses ADD COLUMN IF NOT EXISTS feedback_note TEXT;

    -- FIX 3: Performance indexes
    CREATE INDEX IF NOT EXISTS clients_advisor_idx ON clients(advisor_id);
    CREATE INDEX IF NOT EXISTS analyses_advisor_idx ON analyses(advisor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS analyses_client_idx ON analyses(client_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS people_client_idx ON people(client_id);
    CREATE INDEX IF NOT EXISTS review_req_client_idx ON review_requests(client_id);
    CREATE INDEX IF NOT EXISTS review_req_status_idx ON review_requests(client_id, status);
    CREATE INDEX IF NOT EXISTS module_examples_compound_idx ON module_examples(advisor_id, module_key, auto_generated, rating DESC);
    CREATE INDEX IF NOT EXISTS company_memory_client_idx ON company_memory(client_id);

    -- FIX 5: DSGVO — source client tracking on module_examples
    ALTER TABLE module_examples ADD COLUMN IF NOT EXISTS source_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
    ALTER TABLE module_examples ADD COLUMN IF NOT EXISTS is_cross_client_shareable BOOLEAN DEFAULT TRUE;

    -- Secure onboarding: time-limited setup tokens (48h) instead of plaintext passwords in email
    CREATE TABLE IF NOT EXISTS onboarding_tokens (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS onboarding_tokens_token_idx ON onboarding_tokens(token);
    CREATE INDEX IF NOT EXISTS onboarding_tokens_client_idx ON onboarding_tokens(client_id);
  `);

  // FIX 4: CHECK constraints on enum fields (done separately — DO $$ cannot be inside a multi-statement query string)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_role_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('advisor', 'admin', 'superadmin'));
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='analyses_user_rating_check') THEN
        ALTER TABLE analyses ADD CONSTRAINT analyses_user_rating_check CHECK (user_rating IN (-1, 1));
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='review_requests_status_check') THEN
        ALTER TABLE review_requests ADD CONSTRAINT review_requests_status_check CHECK (status IN ('pending', 'edited', 'approved', 'rejected'));
      END IF;
    END $$;
  `);
}

module.exports = { pool, init };
