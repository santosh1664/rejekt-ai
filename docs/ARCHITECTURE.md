# System Architecture
**Rejekt.ai** · v0.1

---

## High-Level Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        INTERNET                              │
│   Greenhouse API  ·  Ashby API  ·  Lever API  ·  Workday…  │
└──────────────┬───────────────────────────────────────────────┘
               │  HTTPS (JSON)
               ▼
┌─────────────────────────────────┐
│       Scanner  (Node.js)        │
│  scanner.mjs → orchestrator     │
│  ├── Per-ATS concurrency pools  │
│  ├── worker.mjs (per company)   │
│  ├── fingerprint / dedup        │
│  └── freshness checker          │
└───────────────┬─────────────────┘
                │  SQL (pg)
                ▼
┌─────────────────────────────────┐        ┌─────────────────┐
│     PostgreSQL (RDS / Neon)     │◄───────│  ML Classifier  │
│  companies · jobs               │        │  (Python Flask) │
│  scan_runs · user_preferences   │        │  ml/classifier- │
│  user_job_alerts                │        │  server.py      │
└───────────────┬─────────────────┘        └─────────────────┘
                │  SQL (pg)
                ▼
┌─────────────────────────────────┐
│    Web Server  (Express v5)     │
│  server.mjs                     │
│  ├── GET  /api/jobs             │
│  ├── GET  /api/meta             │
│  ├── GET  /api/job/:id          │
│  ├── GET  /api/scan-log         │
│  ├── POST /api/parse-resume     │
│  └── static → public/           │
└───────────────┬─────────────────┘
                │  HTTP / JSON
                ▼
┌─────────────────────────────────┐
│      Browser SPA                │
│  public/index.html              │
│  ├── Job feed + filters         │
│  ├── My Profile drawer          │
│  │   ├── Resume upload & parse  │
│  │   ├── Skill tag-inputs       │
│  │   └── Preferences chips      │
│  └── Scan-log dashboard         │
└─────────────────────────────────┘
```

---

## Component Descriptions

### Scanner (`scanner.mjs`, `scanner/`)

The core data-collection engine. Runs as a CLI (`npm run scan`).

- **Orchestrator** (`scanner/orchestrator.mjs`) — loads all active companies from Postgres, assigns each to a per-ATS concurrency pool (e.g. Greenhouse: 8 concurrent, Lever: 4), and runs all pools in parallel.
- **Worker** (`scanner/worker.mjs`) — calls the correct provider module for a company, receives raw job list, computes fingerprints, diffs against existing DB rows, inserts/updates/closes.
- **Shard mode** — `--shard 1/3` divides the company list alphabetically so three processes can run in parallel on different machines.
- **Watchdog** (`watchdog.mjs`) — monitors the scanner process; restarts it if it crashes or goes silent for > N minutes.

### Providers (`providers/`)

One module per ATS. Each exports a `fetchJobs(company)` function that returns a normalised array of job objects. Supported: `greenhouse`, `ashby`, `lever`, `workday`, `bamboohr`, `workable`, `smartrecruiters`.

### Harvester (`harvester/`)

Discovers new companies by scanning Common Crawl index files for known ATS URL patterns. Runs monthly. Seeds the `companies` table.

### Freshness Checker (`freshness/checker.mjs`)

After each scan, marks jobs that have been absent for `missed_scans ≥ THRESHOLD` consecutive scans as `active = FALSE, closed_at = NOW()`.

### Matching Engine (`matching/matcher.mjs`)

Compares user preferences (`user_preferences` table) against all new jobs written in the current scan. Writes match rows to `user_job_alerts` with a 0–100 score.

### ML Classifier (`ml/`)

- **`train.py`** — trains a scikit-learn pipeline (TF-IDF + LogisticRegression) on labelled job data.
- **`classifier-server.py`** — tiny Flask server (`localhost:5001`) that accepts `{ title, description }` and returns `{ category, careerLevel, employmentType, workplaceType, sponsorship, degreeLevel, salaryMin, salaryMax, expYears }`.
- **`ml-recategorize.mjs`** — batch script that calls the ML server for all un-classified jobs and writes results back to Postgres.

### Web Server (`server.mjs`)

Express v5. Serves:
- Static files from `public/`.
- REST API for the SPA (see [API.md](./API.md)).
- `/api/parse-resume` — multipart upload, text extraction (pdf-parse / mammoth), regex field extraction → JSON profile.

### Frontend SPA (`public/index.html`)

Single self-contained HTML file (no build step, no framework). Key features:
- Live search + multi-filter panel (category, ATS, remote, workplace, experience, salary, degree, visa sponsorship).
- Infinite scroll pagination.
- Match score overlay per card.
- **My Profile drawer** — full profile editor with resume drop-zone, 6-category skill tag-inputs, preferences chips, certifications, saved to `localStorage` (`jd_profile_v2`).

---

## Data Flow — Job Scan

```
npm run scan
  └─ orchestrator: load companies from DB
       └─ for each company (pool):
            worker.fetchJobs(company)
              └─ provider.fetchJobs() → raw JSON from ATS
            compute fingerprint (SHA-256 company+title)
            INSERT ON CONFLICT (fingerprint) DO UPDATE
            freshness: increment missed_scans for absent jobs
            close jobs where missed_scans ≥ 3
  └─ matchNewJobs(): score new jobs against user_preferences
  └─ finishScanRun(): write summary to scan_runs
```

## Data Flow — User Search

```
Browser GET /api/jobs?q=engineer&remote=true&salaryMin=100000
  └─ server.mjs: parse query params → build SQL
       WHERE active = TRUE
         AND to_tsvector(...) @@ plainto_tsquery(q)   -- FTS
         AND remote = TRUE
         AND salary_min >= 100000
       ORDER BY ts_rank DESC, discovered DESC
       LIMIT 20 OFFSET …
  └─ return jobs[] + totalCount to browser
```

---

## Concurrency & Rate Limits

| ATS | Default pool size | Notes |
|-----|------------------|-------|
| Greenhouse | 8 | Unauthenticated JSON API, generous limits |
| Ashby | 6 | Unauthenticated |
| Lever | 4 | Unauthenticated |
| Workday | 3 | Browser-like headers required |
| BambooHR | 4 | Domain-based slug |
| Workable | 4 | Subdomain-based |
| SmartRecruiters | 4 | Unauthenticated |

Pool sizes defined in `lib/pool.mjs → ATS_CONCURRENCY`.

---

## Deployment (Single Node)

```
┌─────────────────────────────────────────────┐
│  Mac / VPS                                  │
│  ├── node server.mjs          (port 3000)   │
│  ├── python ml/classifier-server.py (5001)  │
│  ├── launchd: scanner every 4 h             │
│  └── launchd: watchdog daemon               │
│                                             │
│  External: AWS RDS PostgreSQL               │
└─────────────────────────────────────────────┘
```

launchd plist: `scripts/com.job-discovery-saas.scan.plist`

