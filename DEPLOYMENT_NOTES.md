# RhetorIQ Advisor Login — Deployment Notes

## Issue Summary
Login fails with correct ADVISOR_EMAIL and ADVISOR_PASSWORD even though they're set in Render Dashboard.

## Root Cause Analysis

### What I Checked
1. **seedAdvisor() function** (`server/index.js:245-260`) — ✓ CORRECT
   - Uses bcrypt hash rounds=12
   - Properly inserts into users table
   - Correct schema match

2. **Login endpoint** (`server/routes/auth.js:10-43`) — ✓ CORRECT
   - Uses `bcrypt.compare()` to verify password (line 29)
   - Generates JWT token on successful match
   - Properly handles email case-insensitivity

3. **Database schema** (`server/db.js:7-14`) — ✓ CORRECT
   - users table has: id, email, password_hash, name, role, created_at
   - email column is UNIQUE
   - password_hash is TEXT (sufficient for bcrypt hashes)

### The Problem
The seedAdvisor() function only runs **once at startup** and **only if no account exists** with that email:

```javascript
async function seedAdvisor() {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length) return;  // ← EXIT if account exists
  
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)',
    [email, hash, name, 'advisor']
  );
}
```

**Scenario:**
1. Week 1: Deploy with ADVISOR_PASSWORD="old-password" → account created with hash of "old-password"
2. Week 2: Change ADVISOR_PASSWORD to "new-password" in Render Dashboard
3. Next deployment: seedAdvisor() checks if account exists → YES → skips insertion
4. Database still has hash of "old-password"
5. Login fails with "new-password"

## Solution

Created **`reset-advisor.js`** — a standalone script that:
1. Always deletes the existing advisor account (if any)
2. Creates a fresh one with the current password
3. Guarantees database matches Render env vars

### Files Created
- **`/tmp/RhetorIQ-repo/reset-advisor.js`** — Main reset script
- **`/tmp/RhetorIQ-repo/ADVISOR_SETUP.md`** — Detailed usage guide

### How to Fix Login NOW

**Option A: Quick Fix via Render One-Off Job**
1. Go to Render Dashboard → rhetoriq service
2. Click "One-off Jobs" tab
3. Enter command: `node reset-advisor.js`
4. Click "Run Job"
5. Wait ~10 seconds for completion
6. Try login at https://rhetoriq.ch

**Option B: Local Testing**
```bash
cd /tmp/RhetorIQ-repo/rhetoriq-app/server
export DATABASE_URL="postgres://user:pass@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq"
export ADVISOR_EMAIL="your-email@example.com"
export ADVISOR_PASSWORD="your-password"
node ../../reset-advisor.js
```

### Permanent Fix

Update `server/index.js` seedAdvisor() to always reset (not just on first deployment):

```javascript
// ── Seed Advisor Account ──────────────────────────────────────
async function seedAdvisor() {
  const email = process.env.ADVISOR_EMAIL;
  const password = process.env.ADVISOR_PASSWORD;
  const name = process.env.ADVISOR_NAME || 'Advisor';
  if (!email || !password) return;

  // CHANGE: Delete existing account to ensure password is fresh
  await pool.query('DELETE FROM users WHERE email = $1', [email]);

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)',
    [email, hash, name, 'advisor']
  );
  console.log(`✓ Advisor account created: ${email}`);
}
```

This ensures that every deployment with new env vars creates a fresh account.

## Verification Checklist

After running reset-advisor.js:

- [ ] Script output shows success message
- [ ] Account created with your ADVISOR_EMAIL
- [ ] You can log in at https://rhetoriq.ch with that email/password
- [ ] JWT token is returned and stored in browser localStorage
- [ ] Dashboard loads without 401 errors
- [ ] All client functionality works

## Database Inspection (Optional)

Verify the account was created:

```bash
# Connect to Render PostgreSQL
psql postgresql://rhetoriq:PASSWORD@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq

# Check advisor account
SELECT id, email, name, role, created_at FROM users WHERE role = 'advisor';
```

Expected output:
```
 id |           email            |  name  |  role   |         created_at         
----+----------------------------+--------+---------+----------------------------
  1 | advisor@example.com        | Lorena | advisor | 2026-07-08 15:30:00+00:00
```

## Code Architecture

```
Login Request
    ↓
POST /auth/login (server/routes/auth.js)
    ├─ Query users table by email
    ├─ Compare password via bcrypt
    └─ Return JWT token
    
JWT Token ← Stores user id, email, role
    ↓
Frontend localStorage
    ↓
Authenticated API calls (via middleware/auth.js)
```

## Related Deployments

After login works, consider:
1. Test all advisor features (clients, analyses, reports)
2. Verify scheduled jobs (weekly/monthly reports) can authenticate
3. Check Sentry for any login-related errors
4. Monitor database backups to ensure this deployment is backed up

## Questions?

Check logs:
- **Render service logs:** Deployment → Logs tab
- **Database logs:** (if available from Render)
- **Browser console:** F12 → Console tab during login
- **Render job logs:** One-off Jobs → [Your Job] → Logs
