# Setup & Development Guide

Complete instructions for running Rejekt.ai locally, configuring the environment, and operating the full stack.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | ESM support required |
| npm | 9+ | Bundled with Node.js |
| Python | 3.9+ | For ML classifier service |
| pip | 22+ | Python package manager |
| PostgreSQL client | 14+ | `psql` CLI for migrations |
| macOS | 12+ | Tested on macOS Ventura/Sonoma |

---

## Project Structure

```
rejekt-ai/
├── public/
│   └── index.html          # Single-page app (no build step)
├── scripts/
│   ├── harvestCompanies.js  # Company discovery
│   ├── scanCompanies.js     # Job scraper / ATS scanner
│   ├── mlClassify.js        # Batch ML classification
│   ├── freshnessCheck.js    # Expired job cleanup
│   ├── backfillDescriptions.js  # Description fill-in
│   └── migrate_*.js         # DB migration scripts
├── providers/               # ATS provider modules
│   ├── greenhouse.js
│   ├── ashby.js
│   ├── lever.js
│   └── ...
├── config/
│   └── providers.json       # Provider registry
├── ml/
│   ├── app.py               # Flask ML API server
│   ├── train.py             # Model training script
│   └── model/               # Saved scikit-learn models
├── docs/                    # This documentation folder
├── server.mjs               # Express web server (ESM)
├── restart.sh               # Quick server restart script
├── package.json
└── package-lock.json
```

---

## Initial Setup

### 1. Clone the Repository
```bash
git clone <repo-url> rejekt-ai
cd rejekt-ai
```

### 2. Install Node Dependencies
```bash
npm install
```

Key dependencies installed:
- `express` — web framework
- `pg` — PostgreSQL client
- `pdf-parse` — PDF text extraction (CJS)
- `mammoth` — DOCX text extraction (CJS)
- `cors` — Cross-origin headers (if needed)

### 3. Install Python Dependencies
```bash
pip3 install flask scikit-learn numpy pandas joblib
```

Or using a virtual environment (recommended):
```bash
python3 -m venv venv
source venv/bin/activate
pip install flask scikit-learn numpy pandas joblib
```

### 4. Configure Environment Variables

Create a `.env` file in the project root (or export in your shell):

```bash
# Database
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-HOST.rds.amazonaws.com:5432/rejekt?sslmode=require

# Required: disables SSL certificate verification for AWS RDS
NODE_TLS_REJECT_UNAUTHORIZED=0

# Optional: ML classifier port (default: 5001)
ML_PORT=5001

# Optional: Web server port (default: 3000)
PORT=3000
```

> ⚠️ **Security note**: `NODE_TLS_REJECT_UNAUTHORIZED=0` bypasses SSL verification. This is needed because the self-signed RDS certificate isn't in Node's default trust store. Only set this in development.

### 5. Run Database Migrations

Connect to the database and run all migration scripts in order:

```bash
# Test connection
psql "$DATABASE_URL" -c "SELECT version();"

# Run migrations (run each in order)
node scripts/migrate_001_initial.js
node scripts/migrate_002_ml_fields.js
node scripts/migrate_003_user_prefs.js
# Add newer migrations as they appear
```

Or run them all at once:
```bash
ls scripts/migrate_*.js | sort | xargs -I{} node {}
```

---

## Running the Stack

The full stack consists of two servers that should run simultaneously:

### Web Server (Terminal 1)

```bash
cd rejekt-ai
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.mjs
```

Expected output:
```
🚀 Rejekt.ai running on http://localhost:3000
📦 Serving static files from ./public
🗄️  Database connected
```

Or use the helper script:
```bash
chmod +x restart.sh
./restart.sh
```

The web server provides:
- `http://localhost:3000` — frontend SPA
- `GET /api/jobs` — job search API
- `GET /api/meta` — stats and metadata
- `POST /api/parse-resume` — resume extraction

### ML Classifier (Terminal 2)

```bash
cd rejekt-ai/ml
python3 app.py
```

Expected output:
```
 * Running on http://127.0.0.1:5001
 * Debug mode: off
```

> The ML server is optional for basic usage. Without it, job classification won't run but all other features work normally.

---

## Running Scripts

Scripts are run from the project root. Always set the environment variable:

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Harvest New Companies
Discovers and adds new companies from seed sources (Crunchbase, LinkedIn, etc.):
```bash
node scripts/harvestCompanies.js
node scripts/harvestCompanies.js --limit=500
node scripts/harvestCompanies.js --source=crunchbase
```

### Scan Jobs
Scrapes job listings from all active companies across all ATS providers:
```bash
node scripts/scanCompanies.js
node scripts/scanCompanies.js --concurrency=50
node scripts/scanCompanies.js --provider=greenhouse
node scripts/scanCompanies.js --company="Stripe"
node scripts/scanCompanies.js --dry-run   # Preview without DB writes
```

### Freshness Check
Marks jobs as expired if they're no longer found on the company's ATS:
```bash
node scripts/freshnessCheck.js
node scripts/freshnessCheck.js --days=7   # Check jobs older than 7 days
```

### ML Classification
Runs the ML classifier on unclassified jobs:
```bash
node scripts/mlClassify.js
node scripts/mlClassify.js --batch=100   # Process 100 at a time
node scripts/mlClassify.js --job-id=12345  # Classify a specific job
```

### Backfill Descriptions
Fetches full job descriptions for jobs missing them:
```bash
node scripts/backfillDescriptions.js
node scripts/backfillDescriptions.js --limit=200
```

---

## Automated Scheduling (macOS launchd)

### Install the Scanner as a Scheduled Job

1. Copy the plist to the LaunchAgents directory:
```bash
cp scripts/com.job-discovery-saas.scan.plist ~/Library/LaunchAgents/
```

2. Edit the plist to set correct paths:
```bash
nano ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
```
Update `<string>__PROJECT_DIR__/scripts/run-scan.sh</string>`.

3. Load and start:
```bash
launchctl load ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
launchctl start com.job-discovery-saas.scan
```

4. Verify it's running:
```bash
launchctl list | grep job-discovery
```

5. View logs:
```bash
tail -f /tmp/job-discovery-scan.log
```

### Uninstall
```bash
launchctl stop com.job-discovery-saas.scan
launchctl unload ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist
```

---

## Development Workflow

### Making Frontend Changes

The frontend is a single file at `public/index.html`. No build step needed:

1. Edit `public/index.html`
2. Refresh `http://localhost:3000` in the browser
3. Changes are live immediately (the server serves the file directly)

### Making Server Changes

The server (`server.mjs`) requires a restart after changes:

```bash
# Kill existing server
pkill -f "node server.mjs"

# Restart
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.mjs
```

Or use `restart.sh`:
```bash
./restart.sh
```

### Making Database Schema Changes

1. Write a new migration script in `scripts/`:
```bash
# Name it sequentially
scripts/migrate_004_new_feature.js
```

2. Migration script template:
```javascript
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS new_field TEXT`);
    await client.query('COMMIT');
    console.log('Migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
```

3. Run the migration:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/migrate_004_new_feature.js
```

4. Update `docs/DATABASE.md` with the new columns.

---

## Troubleshooting

### "Cannot connect to database"
```
Error: connect ECONNREFUSED
```
- Ensure you're running from a network that can reach AWS RDS
- Confirm `NODE_TLS_REJECT_UNAUTHORIZED=0` is set
- Check the connection string in your environment
- Test: `psql "$DATABASE_URL" -c "SELECT 1;"`

### "Cannot POST /api/parse-resume" (returns HTML 404)
The server is running an old version loaded before the endpoint was added. Restart the server:
```bash
./restart.sh
```

### "Unexpected token '<'" on Extract & Fill
The server returned an HTML error page instead of JSON. This means:
1. Server is not running → start it: `node server.mjs`
2. Wrong endpoint → check server logs for the request
3. Server crash → restart and check logs

### "ML classifier not responding"
The Flask server at `localhost:5001` is not running. Start it:
```bash
cd ml && python3 app.py
```
If ML is unavailable, job scanning still works — classification is skipped.

### Server starts but jobs don't load
1. Open browser DevTools → Network tab
2. Look at the `GET /api/jobs` response
3. Common issues:
   - Database query timeout (RDS connection flaky) — retry
   - Empty results — run `node scripts/scanCompanies.js` first

### "Too many open files" error during scanning
The scanner opens many concurrent connections. Increase the file descriptor limit:
```bash
ulimit -n 4096
```
Or reduce concurrency in the scan script: `--concurrency=20`.

---

## Verifying the Installation

Run this checklist after setup:

```bash
# 1. Check Node version
node --version   # Should be 18+

# 2. Check Python version
python3 --version   # Should be 3.9+

# 3. Test DB connection
NODE_TLS_REJECT_UNAUTHORIZED=0 psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM jobs;"

# 4. Start web server
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.mjs &

# 5. Test API
curl http://localhost:3000/api/meta
curl "http://localhost:3000/api/jobs?limit=5"

# 6. Start ML server
cd ml && python3 app.py &

# 7. Test ML server
curl http://localhost:5001/health

# 8. Open UI
open http://localhost:3000
```

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Yes | `1` | Set to `0` for AWS RDS |
| `PORT` | No | `3000` | Web server port |
| `ML_PORT` | No | `5001` | ML classifier port |
| `SCAN_CONCURRENCY` | No | `50` | Max parallel scan requests |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
