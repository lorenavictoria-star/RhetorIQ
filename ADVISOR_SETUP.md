# Advisor Account Setup Guide

## Problem
Login fails even though ADVISOR_EMAIL and ADVISOR_PASSWORD are set in Render Dashboard.

## Root Cause
The `seedAdvisor()` function in `server/index.js` only creates an account if none exists with that email. If:
- The password was changed in Render Dashboard after the account was created, OR
- The account was never properly seeded in the database

...then login will fail because the password hash in the database won't match.

## Solution: Reset Advisor Account Script

A new script `/tmp/RhetorIQ-repo/reset-advisor.js` has been created to:
1. Delete any existing advisor account with that email
2. Create a fresh account by hashing the password
3. Insert it into the `users` table

## How to Use

### Option A: Run locally (for testing/development)

```bash
cd /tmp/RhetorIQ-repo/rhetoriq-app/server

# Set environment variables for local testing
export DATABASE_URL="postgres://user:pass@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq"
export ADVISOR_EMAIL="your-email@example.com"
export ADVISOR_PASSWORD="your-secure-password"

# Run the script
node ../../reset-advisor.js
```

### Option B: Run as a Render one-off job (recommended for production)

1. Go to Render Dashboard
2. Select your web service (rhetoriq)
3. Click **"One-off Jobs"** tab
4. Click **"Create Job"**
5. In the command field, enter:
   ```
   node reset-advisor.js
   ```
6. Click **"Run Job"**
7. The job will use the ADVISOR_EMAIL, ADVISOR_PASSWORD, and DATABASE_URL from your Render environment variables

## What the Script Does

1. **Validates** that ADVISOR_EMAIL, ADVISOR_PASSWORD, and DATABASE_URL are set
2. **Connects** to the PostgreSQL database
3. **Checks** if an advisor account with that email exists
4. **Deletes** any existing account (to ensure a fresh start)
5. **Hashes** the password using bcrypt (rounds=12)
6. **Creates** a new advisor account in the `users` table
7. **Confirms** success with a formatted output showing the new account details

## Expected Output

```
[INFO] Starting advisor account reset...
[INFO] Email: advisor@example.com
[INFO] Database: rhetoriq
[STEP 1] Connecting to database...
[✓] Connected successfully
[STEP 2] Checking for existing advisor account with email: advisor@example.com
[WARN] Found existing account (id=1, name="Advisor")
[STEP 3a] Deleting existing account...
[✓] Deleted existing account (1 row removed)
[STEP 3b] Hashing password with bcrypt (rounds=12)...
[✓] Password hashed
[STEP 4] Inserting new advisor account...
[✓] New advisor account created successfully

┌─────────────────────────────────────────────────────┐
│ ADVISOR ACCOUNT RESET COMPLETE                      │
├─────────────────────────────────────────────────────┤
│ ID:         1
│ Email:      advisor@example.com
│ Name:       Advisor
│ Role:       advisor
│ Created:    2026-07-08T15:30:00.000Z
└─────────────────────────────────────────────────────┘

[✓] The advisor account now exists in the database
[✓] You should now be able to log in with:
    Email:    advisor@example.com
    Password: your-secure-password
```

## Troubleshooting

### Error: "DATABASE_URL not set"
- Ensure you're running via Render one-off job (it inherits env vars automatically), OR
- Set DATABASE_URL explicitly in the command

### Error: "ADVISOR_EMAIL not set"
- Check that ADVISOR_EMAIL is configured in Render Dashboard under Environment Variables
- If using local testing, set it explicitly: `export ADVISOR_EMAIL="..."`

### Error: "connect ENOTFOUND" or database connection fails
- Verify the DATABASE_URL is correct: `dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com`
- Check that Render PostgreSQL is running and accessible
- Verify firewall/network rules allow connections

### Error: "UNIQUE constraint violation"
- This should not happen as the script deletes the existing account first
- If it does, manually delete the old account: `DELETE FROM users WHERE email = 'advisor@example.com';`

## Verification

After running the script, verify the account was created:

```bash
psql postgresql://user:pass@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq
SELECT id, email, name, role, created_at FROM users WHERE email = 'advisor@example.com';
```

You should see one row with the new account.

## Next Steps

1. Run the reset-advisor.js script via Render one-off job
2. Wait for it to complete (should be < 5 seconds)
3. Log in to https://rhetoriq.ch with your ADVISOR_EMAIL and ADVISOR_PASSWORD
4. If login still fails, check:
   - Browser console for errors
   - Render logs for any application errors
   - Database to confirm the account exists (see Verification above)

## Files Modified

- **Created:** `/tmp/RhetorIQ-repo/reset-advisor.js` — Standalone script to reset advisor account
- **Reviewed:** `server/index.js` — `seedAdvisor()` function (lines 245-260) is correct but only seeds once
- **Schema:** `server/db.js` — `users` table verified (lines 7-14)

## Why This Approach?

The existing `seedAdvisor()` function is correct but has a limitation:
- It only inserts a new account if no account with that email exists
- If the password changes in Render, the old hash remains and login fails

The reset-advisor.js script solves this by:
1. Explicitly deleting the old account
2. Creating a fresh one with the current password
3. Providing immediate feedback and verification

This ensures that what's in the database **always** matches what's in Render env vars.
