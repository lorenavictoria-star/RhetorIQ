// Daily DB backup — dumps to stdout, logs size
// Run via Render Cron: node server/jobs/backup.js
// Requires: pg_dump in PATH (available on Render) + DATABASE_URL env var
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.join(__dirname, '../../backups');
const outFile = path.join(outDir, `rhetoriq-${stamp}.sql.gz`);

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

try {
  execSync(`pg_dump "${DB_URL}" | gzip > "${outFile}"`, { stdio: 'inherit' });
  const size = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`[backup] ✓ ${outFile} (${size} KB)`);

  // Keep only last 7 backups
  const files = fs.readdirSync(outDir)
    .filter(f => f.endsWith('.sql.gz'))
    .sort()
    .reverse();
  files.slice(7).forEach(f => {
    fs.unlinkSync(path.join(outDir, f));
    console.log(`[backup] removed old backup: ${f}`);
  });
} catch (e) {
  console.error('[backup] FAILED:', e.message);
  process.exit(1);
}
