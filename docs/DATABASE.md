# Database Reference
**Rejekt.ai** · PostgreSQL (RDS / Neon)

---

## Connection

```bash
# .env.local
DATABASE_URL=postgresql://user:password@host:5432/jobhub?sslmode=require
NODE_TLS_REJECT_UNAUTHORIZED=0   # RDS self-signed cert bypass
```

Run migrations:
```bash
npm run migrate          # node db/migrate.mjs
# or
psql $DATABASE_URL -f db/schema.sql
```

---

## Tables

### `companies`
Source of truth for which company career pages to scan.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | |
| `name` | TEXT | Display name |
| `ats` | TEXT | `greenhouse \| ashby \| lever \| workday \| bamboohr \| workable \| smartrecruiters` |
| `slug` | TEXT | ATS-specific identifier (e.g. `openai`) |
| `meta` | JSONB | Extra ATS fields: `tenant`, `shard`, `site` (Workday); `domain` (BambooHR) |
| `active` | BOOLEAN | `false` = board 404'd; skipped in scans |
| `priority` | SMALLINT | 1 = scan every run · 10 = scan weekly |
| `last_scan` | TIMESTAMPTZ | When the company was last successfully scanned |
| `scan_errors` | INT | Consecutive errors; auto-disabled at threshold |
| `discovered` | TIMESTAMPTZ | When harvested from Common Crawl |

**Unique constraint:** `(ats, slug)`

**Key indexes:** `ats`, `active`, `last_scan`, `priority`

---

### `raw_job_postings`

Preserves the provider payload and source fields before canonical processing. It is keyed by `(source, url)` today and carries `content_hash` and `processing_status` so enrichment can be rerun.

### `jobs`
One row per unique job posting. Rows are **never deleted** — only deactivated.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | |
| `url` | TEXT UNIQUE | Canonical apply URL |
| `title` | TEXT | Job title as returned by ATS |
| `company` | TEXT | Company display name |
| `company_id` | INT → companies | FK (nullable) |
| `location` | TEXT | Raw location string |
| `remote` | BOOLEAN | True if job is remote |
| `ats` | TEXT | Source ATS |
| `fingerprint` | CHAR(16) | `SHA-256(company \| normaliseTitle)[:16]` — same-company dedup |
| `title_fp` | CHAR(16) | `SHA-256(normaliseTitle)[:16]` — cross-listing detection |
| `category` | TEXT | Role category (see values below) |
| `category_source` | TEXT | `keyword` (rule-based) or `ml` (classifier) |
| `posted_at` | TIMESTAMPTZ | Date from ATS (may be null) |
| `discovered` | TIMESTAMPTZ | When first seen by scanner |
| `last_seen` | TIMESTAMPTZ | Last scan that returned this job |
| `closed_at` | TIMESTAMPTZ | When marked inactive |
| `active` | BOOLEAN | `false` once `missed_scans ≥ 3` |
| `missed_scans` | SMALLINT | Incremented each scan the job is absent |
| `raw` | JSONB | Full ATS API response |
| `raw_job_id` | BIGINT | Preserved raw source record |
| `description_hash` | CHAR(16) | Description content fingerprint |
| `display_title` / `normalized_title` | TEXT | Canonical title pair |
| `canonical_role` / `role_family` | TEXT | Controlled canonical role fields |
| `description_clean` | TEXT | Searchable cleaned description |
| `status` | TEXT | Current processing/publication state |

### `job_sources`

Links canonical jobs to one or more source postings and stores source URL, ATS type, external ID, and freshness timestamps.

### `job_classifications`

Stores field-level classification history, confidence, classifier version, and evidence.

### `skills`, `skill_aliases`, and `job_skills`

Provide the canonical skill vocabulary, aliases, and required/preferred/mentioned relationships. The scanner currently creates the tables and normalization helpers; skill extraction is the next enrichment step.

**ML-extracted fields** (added via `db/add-filters.mjs`):

| Column | Type | Values |
|--------|------|--------|
| `career_level` | TEXT | `ENTRY \| MID \| SENIOR \| LEAD \| MANAGER \| EXECUTIVE` |
| `employment_type` | TEXT | `FULL_TIME \| PART_TIME \| CONTRACT \| INTERNSHIP` |
| `workplace_type` | TEXT | `REMOTE \| HYBRID \| ON_SITE` |
| `sponsorship` | TEXT | `AVAILABLE \| NOT_AVAILABLE \| UNKNOWN` |
| `degree_level` | TEXT | `BACHELOR \| MASTER \| PHD \| NONE` |
| `salary_min` | INT | USD annual (null if not extracted) |
| `salary_max` | INT | USD annual (null if not extracted) |
| `exp_years_min` | SMALLINT | Minimum years of experience |
| `exp_years_max` | SMALLINT | Maximum years of experience |
| `description` | TEXT | Full job description text |
| `description_tsv` | TSVECTOR | GIN-indexed FTS vector on description |

**Category values:**
`data | devops | security | product | design | engineering | sales | marketing | finance | legal | hr | operations | research | healthcare | education | trades | other`

**Key indexes:**
- `GIN` on `to_tsvector('english', title || ' ' || company)` — full-text search
- `GIN` on `title gin_trgm_ops` — trigram ILIKE
- `GIN` on `description_tsv` — description full-text
- `idx_jobs_active`, `idx_jobs_fingerprint`, `idx_jobs_category`, `idx_jobs_discovered`

---

### `scan_runs`
Audit log of every scanner invocation.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | |
| `started_at` | TIMESTAMPTZ | |
| `finished_at` | TIMESTAMPTZ | null while running |
| `companies_scanned` | INT | |
| `companies_errored` | INT | |
| `jobs_fetched` | INT | Total jobs seen this run |
| `jobs_new` | INT | Net new insertions |
| `jobs_reactivated` | INT | Previously closed, now seen again |
| `jobs_closed` | INT | Marked inactive this run |
| `status` | TEXT | `running \| completed \| failed` |

Zombie rows (stuck `running` for > 90 min) are auto-failed at the start of the next scan.

---

### `user_preferences`
Per-user matching preferences.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `user_id` | UUID | Application user ID |
| `title_keywords` | TEXT[] | e.g. `['software engineer', 'ml engineer']` |
| `locations` | TEXT[] | e.g. `['dallas', 'remote']` |
| `remote_only` | BOOLEAN | |
| `categories` | TEXT[] | Default `{engineering}` |
| `exclude_companies` | TEXT[] | Company names to suppress |
| `min_match_score` | SMALLINT | 0–100, default 50 |
| `notify_email` | BOOLEAN | |
| `notify_push` | BOOLEAN | |
| `active` | BOOLEAN | |
| `created_at / updated_at` | TIMESTAMPTZ | |

---

### `user_job_alerts`
Jobs matched to users. Source of the personalised feed.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | |
| `user_id` | UUID | |
| `job_id` | BIGINT → jobs | |
| `pref_id` | UUID → user_preferences | |
| `score` | SMALLINT | 0–100 match score |
| `seen` | BOOLEAN | User opened the job |
| `saved` | BOOLEAN | User bookmarked |
| `applied` | BOOLEAN | User marked applied |
| `created_at` | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, job_id)`

---

## Migration Guide

All DDL is idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).

```bash
# Initial setup
npm run migrate

# Add description + FTS index (one-time)
node --env-file=.env.local db/add-description.mjs

# Add ML filter columns (one-time)
node --env-file=.env.local db/add-filters.mjs

# Drop jobs outside coverage (US, Canada, EU, Australia; see JOB_REGIONS)
node --env-file=.env.local db/filter-us.mjs --dry-run   # preview
node --env-file=.env.local db/filter-us.mjs
```

## Useful Queries

```sql
-- Active job count by category
SELECT category, COUNT(*) FROM jobs WHERE active GROUP BY 1 ORDER BY 2 DESC;

-- Companies with most open roles
SELECT company, COUNT(*) n FROM jobs WHERE active GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Jobs added today
SELECT COUNT(*) FROM jobs WHERE discovered >= CURRENT_DATE;

-- Zombie scan runs
SELECT * FROM scan_runs WHERE status = 'running' AND started_at < NOW() - INTERVAL '90 minutes';

-- Full-text search
SELECT title, company, url
FROM jobs
WHERE active AND to_tsvector('english', title || ' ' || company) @@ plainto_tsquery('ml engineer')
ORDER BY ts_rank(to_tsvector('english', title || ' ' || company), plainto_tsquery('ml engineer')) DESC
LIMIT 10;
```

