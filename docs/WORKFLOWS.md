# Operational Workflows
**Rejekt.ai**

This document covers every recurring operation and when to run it.

---

## 1. Company Harvest (Monthly)

Discovers new companies from the Common Crawl web index.

```bash
npm run seed
# or
node --env-file=.env.local harvester/seed.mjs
```

**What it does:**
1. Downloads Common Crawl index segments.
2. Scans for URLs matching known ATS patterns (e.g. `boards.greenhouse.io/<slug>`, `jobs.ashbyhq.com/<slug>`).
3. Inserts new `(ats, slug)` pairs into `companies` table (`ON CONFLICT DO NOTHING`).

**When to run:** Monthly, or when you want to add a batch of new companies.

**Manual company insert:**
```sql
INSERT INTO companies (name, ats, slug) VALUES ('OpenAI', 'greenhouse', 'openai');
```

---

## 2. Full Scan (Every 4 Hours via launchd)

Fetches all jobs from all active companies and updates the database.

```bash
npm run scan
# or
node --env-file=.env.local scanner.mjs --scan
```

**What it does:**
1. Auto-fails zombie `scan_runs` rows (stuck > 90 min).
2. Inserts a new `scan_runs` row (`status = 'running'`).
3. Loads all `active = TRUE` companies from Postgres.
4. Dispatches companies to per-ATS concurrency pools.
5. For each company: fetches jobs, computes fingerprints, upserts to `jobs`.
6. Freshness pass: closes jobs absent for ≥ 3 consecutive scans.
7. Matching pass: scores new jobs against `user_preferences`.
8. Updates `scan_runs` with final counts and `status = 'completed'`.

**Shard mode** (3 parallel processes, each handles ⅓ of companies):
```bash
npm run scan:1   # shard 1 of 3
npm run scan:2   # shard 2 of 3
npm run scan:3   # shard 3 of 3
```

**Dry run** (no DB writes):
```bash
node --env-file=.env.local scanner.mjs --scan --dry-run
```

**Single ATS:**
```bash
node --env-file=.env.local scanner.mjs --scan --ats greenhouse
```

**Single company:**
```bash
node --env-file=.env.local scanner.mjs --scan --company openai
```

---

## 3. Freshness Check (Runs inside scan, or standalone)

Marks jobs closed if they have not been seen in recent scans.

```bash
npm run freshen
# or
node --env-file=.env.local scanner.mjs --freshen
```

**Logic:**
- `missed_scans` is incremented each time a job is absent from an ATS response.
- When `missed_scans ≥ 3` (configurable), `active = FALSE` and `closed_at = NOW()`.
- Jobs that reappear have `missed_scans` reset and `active = TRUE`.

---

## 4. ML Classification (On-demand / Weekly)

Re-classifies all jobs without ML-sourced fields using the Python classifier.

**Step 1 — Start the classifier server:**
```bash
npm run ml:server
# → Flask server on localhost:5001
```

**Step 2 — Run batch classification:**
```bash
npm run ml:classify
# node --env-file=.env.local scripts/ml-recategorize.mjs
```

**Step 3 — Retrain the model (when you have new labelled data):**
```bash
npm run ml:train
# python3 ml/train.py
# → overwrites ml/model.joblib
```

**What the ML model extracts:**
- `category` — role category (engineering, data, devops…)
- `career_level` — ENTRY / MID / SENIOR / LEAD / MANAGER / EXECUTIVE
- `employment_type` — FULL_TIME / PART_TIME / CONTRACT / INTERNSHIP
- `workplace_type` — REMOTE / HYBRID / ON_SITE
- `sponsorship` — AVAILABLE / NOT_AVAILABLE / UNKNOWN
- `degree_level` — BACHELOR / MASTER / PHD / NONE
- `salary_min / salary_max` — USD annual
- `exp_years_min / exp_years_max`

---

## 5. Description Backfill (One-time)

Fetches and stores the full job description for every job that has `description IS NULL`.

```bash
npm run db:add-description
# node --env-file=.env.local db/add-description.mjs
```

Builds the `description_tsv` GIN index after completion.

---

## 6. Database Migration (On schema change)

```bash
npm run migrate
# node --env-file=.env.local db/migrate.mjs
```

All DDL uses `IF NOT EXISTS` — safe to re-run.

---

## 7. Resume Parse (User-triggered, real-time)

Triggered when a user uploads a PDF/DOCX in the My Profile drawer.

```
Browser → POST /api/parse-resume (multipart)
  └─ server.mjs: parse multipart body manually
       ├─ PDF  → pdf-parse → raw text
       ├─ DOCX → mammoth   → raw text
       └─ TXT  → UTF-8 decode
  └─ regex extraction: name, email, phone, LinkedIn, GitHub,
       location, title, summary, workAuth, expYears,
       skills2 (per category), certifications
  └─ return JSON → frontend merges into localStorage profile
```

---

## 8. Job Matching (Runs inside scan automatically)

Can also be run standalone:
```bash
node --env-file=.env.local matching/matcher.mjs --verbose
```

**Logic:**
1. Load all active `user_preferences`.
2. For each user, query jobs matching their keywords, locations, categories.
3. Score each job (keyword overlap, location match, remote preference).
4. `INSERT INTO user_job_alerts` with score, skip duplicates (`ON CONFLICT DO NOTHING`).

---

## 9. Watchdog (Always-on daemon)

Monitors the scanner and web server; restarts them if they crash.

```bash
npm run watchdog
npm run watchdog:verbose
```

Usually managed by launchd (`scripts/com.job-discovery-saas.scan.plist`).

---

## 10. Stats (Quick health check)

```bash
npm run stats
# node --env-file=.env.local scanner.mjs --stats
```

Prints: total companies, active jobs, jobs added in last 24 h, last scan time, scan run history.

---

## Scheduled Automation (macOS launchd)

```bash
# Install launchd job (scans every 4 hours)
cp scripts/com.job-discovery-saas.scan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.job-discovery-saas.scan.plist

# Check status
launchctl list | grep job-discovery

# View logs
tail -f logs/launchd-stdout.log
tail -f logs/launchd-stderr.log
```

