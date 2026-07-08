#!/usr/bin/env node
/**
 * Reset Advisor Account Script
 *
 * This script ensures a real advisor account exists in the database
 * that matches the ADVISOR_EMAIL and ADVISOR_PASSWORD env vars set in Render.
 *
 * It:
 * 1. Reads ADVISOR_EMAIL and ADVISOR_PASSWORD from process.env
 * 2. Connects to the Render PostgreSQL database
 * 3. Deletes any existing advisor account with that email
 * 4. Creates a NEW advisor account by hashing the password and inserting into users table
 * 5. Prints success/error
 *
 * Usage:
 *   ADVISOR_EMAIL=user@example.com ADVISOR_PASSWORD=securepass \
 *   DATABASE_URL=postgres://user:pass@host/db node reset-advisor.js
 */

require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const EMAIL = process.env.ADVISOR_EMAIL;
const PASSWORD = process.env.ADVISOR_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

async function resetAdvisor() {
  // Validation
  if (!EMAIL) {
    console.error('[ERROR] ADVISOR_EMAIL not set in environment variables');
    process.exit(1);
  }
  if (!PASSWORD) {
    console.error('[ERROR] ADVISOR_PASSWORD not set in environment variables');
    process.exit(1);
  }
  if (!DATABASE_URL) {
    console.error('[ERROR] DATABASE_URL not set in environment variables');
    process.exit(1);
  }

  console.log('[INFO] Starting advisor account reset...');
  console.log(`[INFO] Email: ${EMAIL}`);
  console.log(`[INFO] Database: ${DATABASE_URL.split('@')[1]?.split('/')[1] || 'unknown'}`);

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    // Step 1: Connect to database
    console.log('[STEP 1] Connecting to database...');
    await pool.query('SELECT 1');
    console.log('[✓] Connected successfully');

    // Step 2: Check if account exists
    console.log(`[STEP 2] Checking for existing advisor account with email: ${EMAIL}`);
    const checkRes = await pool.query('SELECT id, name FROM users WHERE email = $1', [EMAIL]);

    if (checkRes.rows.length > 0) {
      const existingId = checkRes.rows[0].id;
      const existingName = checkRes.rows[0].name;
      console.log(`[WARN] Found existing account (id=${existingId}, name="${existingName}")`);

      // Step 3a: Delete existing account
      console.log('[STEP 3a] Deleting existing account...');
      const delRes = await pool.query('DELETE FROM users WHERE id = $1', [existingId]);
      console.log(`[✓] Deleted existing account (${delRes.rowCount} row removed)`);
    } else {
      console.log('[INFO] No existing account found — will create fresh');
    }

    // Step 4: Hash the password
    console.log('[STEP 3b] Hashing password with bcrypt (rounds=12)...');
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    console.log('[✓] Password hashed');

    // Step 5: Insert new advisor account
    console.log('[STEP 4] Inserting new advisor account...');
    const insertRes = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [EMAIL, passwordHash, 'Advisor', 'advisor']
    );

    const newUser = insertRes.rows[0];
    console.log('[✓] New advisor account created successfully');
    console.log(`
    ┌─────────────────────────────────────────────────────┐
    │ ADVISOR ACCOUNT RESET COMPLETE                      │
    ├─────────────────────────────────────────────────────┤
    │ ID:         ${newUser.id}
    │ Email:      ${newUser.email}
    │ Name:       ${newUser.name}
    │ Role:       ${newUser.role}
    │ Created:    ${newUser.created_at}
    └─────────────────────────────────────────────────────┘
    `);

    console.log('[✓] The advisor account now exists in the database');
    console.log('[✓] You should now be able to log in with:');
    console.log(`    Email:    ${EMAIL}`);
    console.log(`    Password: ${PASSWORD}`);

    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Failed to reset advisor account:');
    console.error(`  ${error.message}`);
    if (error.code) {
      console.error(`  Code: ${error.code}`);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

resetAdvisor();
