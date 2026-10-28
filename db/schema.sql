-- ============================================================
-- Rejekt.ai — PostgreSQL Schema
-- ============================================================
-- Run: psql $DATABASE_URL -f db/schema.sql
-- Or:  node db/migrate.mjs

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- trigram for fast LIKE/ILIKE search

-- ── companies ───────────────────────────────────────────────
-- Source of truth for what to scan.
-- Populated by the Common Crawl harvester (runs monthly).
-- Operators can also insert manually.
CREATE TABLE IF NOT EXISTS companies (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  ats          TEXT NOT NULL,           -- greenhouse | ashby | lever | workday | bamboohr | workable | smartrecruiters | recruitee | breezy | pinpoint | rippling | teamtailor | oraclecloud
  slug         TEXT NOT NULL,           -- ATS-specific identifier (e.g. 'openai', 'nvidia')
  meta         JSONB DEFAULT '{}',      -- extra fields: tenant, shard, site (Workday); domain (BambooHR)
  active       BOOLEAN DEFAULT TRUE,    -- false = board 404'd, skip
  priority     SMALLINT DEFAULT 5,      -- 1=highest (scan every run), 10=lowest (scan weekly)
  last_scan    TIMESTAMPTZ,
  scan_errors  INT DEFAULT 0,           -- consecutive errors → disable
  discovered   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ats, slug)
);

CREATE INDEX IF NOT EXISTS idx_companies_ats        ON companies(ats);
CREATE INDEX IF NOT EXISTS idx_companies_active     ON companies(active);
CREATE INDEX IF NOT EXISTS idx_companies_last_scan  ON companies(last_scan);
CREATE INDEX IF NOT EXISTS idx_companies_priority   ON companies(priority);

-- ── raw_job_postings ───────────────────────────────────────
-- Immutable source material for reprocessing and enrichment reruns.
CREATE TABLE IF NOT EXISTS raw_job_postings (
  id                 BIGSERIAL PRIMARY KEY,
  source             TEXT NOT NULL,
  external_job_id    TEXT,
  url                TEXT NOT NULL,
  company_raw        TEXT,
  title_raw          TEXT,
  location_raw       TEXT,
  description_raw    TEXT,
  salary_raw         TEXT,
  employment_type_raw TEXT,
  posted_at_raw      TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash       CHAR(16),
  processing_status  TEXT NOT NULL DEFAULT 'RAW',
  processing_error   TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scraped_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, url)
);

CREATE INDEX IF NOT EXISTS idx_raw_jobs_source_external ON raw_job_postings(source, external_job_id);
CREATE INDEX IF NOT EXISTS idx_raw_jobs_status          ON raw_job_postings(processing_status);
CREATE INDEX IF NOT EXISTS idx_raw_jobs_content_hash    ON raw_job_postings(content_hash);
CREATE INDEX IF NOT EXISTS idx_raw_jobs_last_seen       ON raw_job_postings(last_seen_at DESC);

-- ── jobs ────────────────────────────────────────────────────
-- One row per unique job posting. Never deleted — only deactivated.
CREATE TABLE IF NOT EXISTS jobs (
  id              BIGSERIAL PRIMARY KEY,
  url             TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  display_title   TEXT,
  normalized_title TEXT,
  company         TEXT NOT NULL,
  company_id      INT REFERENCES companies(id) ON DELETE SET NULL,
  location        TEXT DEFAULT '',
  remote          BOOLEAN,
  ats             TEXT NOT NULL,
  raw_job_id      BIGINT REFERENCES raw_job_postings(id) ON DELETE SET NULL,
  fingerprint     CHAR(16),             -- SHA-256(company|normalizeTitle) — same-company dedup
  title_fp        CHAR(16),             -- SHA-256(normalizeTitle only)   — cross-listing detection
  category        TEXT DEFAULT 'engineering',  -- see classifyCategory() in lib/fingerprint.mjs:
                                                 -- data | devops | security | product | design | engineering |
                                                 -- sales | marketing | finance | legal | hr | operations |
                                                 -- research | healthcare | education | trades | other
  category_source TEXT DEFAULT 'keyword',      -- 'keyword' (lib/fingerprint.mjs classifyCategory) | 'ml' (ml/classify.py)
  canonical_role  TEXT,
  role_family     TEXT,
  role_specialization TEXT,
  description_clean TEXT,
  status          TEXT DEFAULT 'READY',
  posted_at       TIMESTAMPTZ,
  discovered      TIMESTAMPTZ DEFAULT NOW(),
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,          -- set when job goes inactive
  active          BOOLEAN DEFAULT TRUE,
  missed_scans    SMALLINT DEFAULT 0,   -- incremented each scan it's absent; reset when seen
  raw             JSONB,                -- full ATS API response
  description     TEXT,                 -- extracted searchable description
  career_level    TEXT DEFAULT 'UNKNOWN',
  min_exp_years   SMALLINT,
  max_exp_years   SMALLINT,
  degree_required JSONB DEFAULT '[]'::jsonb,
  sponsorship_status TEXT DEFAULT 'NOT_MENTIONED',
  employment_type TEXT DEFAULT 'UNKNOWN',
  workplace_type  TEXT DEFAULT 'UNKNOWN',
  salary_min_annual INTEGER,
  salary_max_annual INTEGER,
  salary_currency TEXT DEFAULT 'USD',
  -- skill_tags is legacy: nothing in the pipeline writes it anymore (see
  -- lib/db.mjs's upsertExtractedSkills, which writes job_skills/skills
  -- instead). Authoritative source going forward is job_skills ⋈ skills;
  -- server.mjs's /api/jobs derives a flat skill_tags array from that at
  -- response time (compat-only, not read from this column) for any
  -- consumer that hasn't moved to the structured skills:{required,
  -- preferred,mentioned} shape. Left in place, defaulted to '{}', only so
  -- a query against it doesn't error while any remaining consumer migrates.
  skill_tags      TEXT[] DEFAULT '{}',
  extraction_confidence REAL,
  extraction_version TEXT,
  description_hash TEXT,
  -- seniority_level is the authoritative career-level field going forward.
  -- career_level (above) is legacy: nothing in the pipeline writes it
  -- anymore (see lib/db.mjs — it has zero references), left in place only
  -- so a query against it doesn't error while any remaining external
  -- consumer migrates. See lib/seniority.mjs for the classifier.
  seniority_level TEXT DEFAULT 'UNKNOWN'
);

-- Keep the schema reproducible for databases created before these columns
-- existed. CREATE TABLE IF NOT EXISTS does not alter an existing table.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS category_source TEXT DEFAULT 'keyword';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS raw_job_id BIGINT REFERENCES raw_job_postings(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS display_title TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS normalized_title TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS canonical_role TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS role_family TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS role_specialization TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_clean TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'READY';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS career_level TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS min_exp_years SMALLINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_exp_years SMALLINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS degree_required JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sponsorship_status TEXT DEFAULT 'NOT_MENTIONED';
DO $$
BEGIN
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_sponsorship_status_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_sponsorship_status_check CHECK (
    sponsorship_status IN (
      'AVAILABLE', 'NOT_AVAILABLE', 'RESTRICTED', 'NOT_MENTIONED', 'UNCLEAR',
      'SPONSORS', 'NO_SPONSORSHIP', 'MAY_SPONSOR', 'UNKNOWN'
    )
  );
END $$;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workplace_type TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min_annual INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max_annual INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_currency TEXT DEFAULT 'USD';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS skill_tags TEXT[] DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS extraction_confidence REAL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS extraction_version TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_hash TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS seniority_level TEXT DEFAULT 'UNKNOWN';
DO $$
BEGIN
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_seniority_level_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_seniority_level_check CHECK (
    seniority_level IN (
      'INTERN', 'ENTRY', 'JUNIOR', 'MID', 'SENIOR', 'STAFF', 'PRINCIPAL',
      'LEAD', 'MANAGER', 'DIRECTOR', 'EXECUTIVE', 'UNKNOWN'
    )
  );
END $$;

-- ── Structured eligibility fields (experience/education/sponsorship/
-- citizenship/clearance/salary) — see lib/experience.mjs, lib/education.mjs,
-- lib/work-eligibility.mjs, lib/salary-extract.mjs. Confidence/evidence for
-- each lives in job_classifications (field_name per extractor), not as
-- per-field columns here, to avoid schema bloat.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_requirement_type TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS education_level TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS education_requirement TEXT DEFAULT 'UNKNOWN';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS education_equivalent_experience BOOLEAN DEFAULT FALSE;
-- citizenship_requirement is nullable and has no default: NULL means "no
-- restriction detected", which is a different fact from any named value —
-- never coalesce this to a string default.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS citizenship_requirement TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS itar_related BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS clearance_type TEXT DEFAULT 'NONE';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS clearance_requirement TEXT DEFAULT 'NONE';
-- Employer-stated salary, preserved as given — never annualized in place.
-- salary_min_annual/salary_max_annual (above) remain the separate derived
-- normalized-to-annual view used for filtering/sorting across periods.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min_raw INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max_raw INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_period TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS eligibility_extraction_version TEXT;

DO $$
BEGIN
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_experience_requirement_type_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_experience_requirement_type_check
    CHECK (experience_requirement_type IN ('REQUIRED', 'PREFERRED', 'UNKNOWN'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_education_level_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_education_level_check
    CHECK (education_level IN ('NONE', 'HIGH_SCHOOL', 'ASSOCIATE', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'UNKNOWN'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_education_requirement_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_education_requirement_check
    CHECK (education_requirement IN ('REQUIRED', 'PREFERRED', 'UNKNOWN'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_clearance_type_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_clearance_type_check
    CHECK (clearance_type IN ('NONE', 'PUBLIC_TRUST', 'SECRET', 'TOP_SECRET', 'TS_SCI', 'OTHER', 'UNKNOWN'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_clearance_requirement_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_clearance_requirement_check
    CHECK (clearance_requirement IN ('REQUIRED_NOW', 'ELIGIBLE_TO_OBTAIN', 'PREFERRED', 'NONE', 'UNKNOWN'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_salary_period_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_salary_period_check
    CHECK (salary_period IS NULL OR salary_period IN ('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'));
  ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_salary_raw_range_check;
  ALTER TABLE jobs ADD CONSTRAINT jobs_salary_raw_range_check
    CHECK (salary_max_raw IS NULL OR salary_min_raw IS NULL OR salary_max_raw >= salary_min_raw);
END $$;

-- Core lookup
CREATE INDEX IF NOT EXISTS idx_jobs_url           ON jobs(url);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint   ON jobs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_title_fp      ON jobs(title_fp);
CREATE INDEX IF NOT EXISTS idx_jobs_active        ON jobs(active);
CREATE INDEX IF NOT EXISTS idx_jobs_ats           ON jobs(ats);
CREATE INDEX IF NOT EXISTS idx_jobs_company_id    ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_raw_job_id    ON jobs(raw_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_category      ON jobs(category);
CREATE INDEX IF NOT EXISTS idx_jobs_role_family   ON jobs(role_family) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_discovered    ON jobs(discovered DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_at     ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_remote        ON jobs(remote);
CREATE INDEX IF NOT EXISTS idx_jobs_career_level       ON jobs(career_level)       WHERE active = TRUE;
-- Predicate matches port 3000's actual filter (active = TRUE), not the
-- pipeline's status = 'READY' — a mismatched partial-index predicate is
-- never used by the planner even though it looks plausible at a glance.
CREATE INDEX IF NOT EXISTS idx_jobs_seniority_active   ON jobs(seniority_level)    WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_employment_type    ON jobs(employment_type)    WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_workplace_type     ON jobs(workplace_type)     WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_sponsorship_status ON jobs(sponsorship_status) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_salary_min         ON jobs(salary_min_annual)  WHERE active = TRUE AND salary_min_annual IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_education_level     ON jobs(education_level)     WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_clearance_type      ON jobs(clearance_type)      WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_citizenship_req      ON jobs(citizenship_requirement) WHERE active = TRUE AND citizenship_requirement IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_exp_requirement_type ON jobs(experience_requirement_type) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_skill_tags         ON jobs USING GIN(skill_tags) WHERE active = TRUE;

-- Trigram index for fast ILIKE search on title
CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm ON jobs USING GIN (title gin_trgm_ops);

-- Superseded by idx_jobs_search_vector below (a strict superset: title +
-- company + canonical_role + role_family + description, weighted).
DROP INDEX IF EXISTS idx_jobs_fts;

-- ── Full-text search: persisted, weighted, trigger-maintained ──────────────
-- Previously api/server.mjs's /jobs?q= computed to_tsvector(...) at query
-- time over 5 concatenated columns, with a matching GIN expression index
-- (idx_jobs_canonical_fts) defined in this very file but NEVER ACTUALLY
-- APPLIED to the live database (migrate.mjs is run manually; this index
-- was added here at some point and the migration was never re-run) — found
-- live via pg_indexes, root cause of the /jobs?q= 30s statement timeout.
-- Rather than just deploying the missing expression index, this replaces
-- it with a real materialized+weighted column: search_vector is computed
-- once per write (trigger below) instead of once per read, ranked search
-- (ts_rank_cd) becomes cheap since it reads the stored vector instead of
-- recomputing to_tsvector per row, and title matches can be weighted above
-- incidental description mentions.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION jobs_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.display_title, NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.canonical_role, '') || ' ' || coalesce(NEW.role_family, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description_clean, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_search_vector ON jobs;
CREATE TRIGGER trg_jobs_search_vector
  BEFORE INSERT OR UPDATE OF display_title, title, company, canonical_role, role_family, description_clean
  ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_search_vector_update();

-- Backfilling ~107K existing rows and building the GIN index are both left
-- to scripts/backfill-search-vector.mjs, run separately after this
-- migration — a single UPDATE across the whole table risks exceeding this
-- migration's 120s statement_timeout, and building the GIN index over
-- already-populated data (one bulk build) is far cheaper than maintaining
-- it incrementally during 107K individual row updates. The column/trigger
-- above are enough for this migration alone: every NEW write is already
-- correctly maintained from this point forward.

-- ── job_sources ─────────────────────────────────────────────
-- A canonical job may be represented by more than one source posting.
CREATE TABLE IF NOT EXISTS job_sources (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  raw_job_id      BIGINT REFERENCES raw_job_postings(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,
  external_job_id TEXT,
  url             TEXT NOT NULL,
  ats_type        TEXT,
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, url)
);

CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_source_external ON job_sources(source, external_job_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_url ON job_sources(url);

-- ── job_classifications ────────────────────────────────────
-- Field-level classification history for explainability and reruns.
CREATE TABLE IF NOT EXISTS job_classifications (
  id                 BIGSERIAL PRIMARY KEY,
  job_id             BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  predicted_value    TEXT,
  confidence         REAL,
  classifier_version TEXT NOT NULL,
  evidence           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, field_name, classifier_version)
);

CREATE INDEX IF NOT EXISTS idx_job_classifications_job ON job_classifications(job_id);
CREATE INDEX IF NOT EXISTS idx_job_classifications_field ON job_classifications(field_name, predicted_value);

-- ── skills ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id              BIGSERIAL PRIMARY KEY,
  canonical_name  TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  category        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_aliases (
  id              BIGSERIAL PRIMARY KEY,
  skill_id        BIGINT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS job_skills (
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill_id    BIGINT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  importance  TEXT NOT NULL DEFAULT 'MENTIONED',
  confidence  REAL,
  evidence    TEXT,
  PRIMARY KEY (job_id, skill_id),
  CHECK (importance IN ('REQUIRED', 'PREFERRED', 'MENTIONED'))
);

CREATE INDEX IF NOT EXISTS idx_job_skills_skill ON job_skills(skill_id, job_id);

-- ── job_locations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_locations (
  id           BIGSERIAL PRIMARY KEY,
  job_id       BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  city         TEXT,
  state_code   TEXT,
  country_code CHAR(2),
  metro_area   TEXT,
  latitude     NUMERIC(9,6),
  longitude    NUMERIC(9,6),
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, city, state_code, country_code)
);
-- is_remote_restriction distinguishes "this is a real office location" from
-- "this remote role is restricted to this region" (city stays NULL either
-- way for a remote entry — see lib/location.mjs; "Remote" is never stored
-- as a city). region holds a freeform label (e.g. "Europe") only when no
-- structured state/country match was found for a remote restriction.
ALTER TABLE job_locations ADD COLUMN IF NOT EXISTS is_remote_restriction BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE job_locations ADD COLUMN IF NOT EXISTS region TEXT;

CREATE INDEX IF NOT EXISTS idx_job_locations_job ON job_locations(job_id);
CREATE INDEX IF NOT EXISTS idx_job_locations_region ON job_locations(country_code, state_code, city);

-- ── job_processing_events ──────────────────────────────────
CREATE TABLE IF NOT EXISTS job_processing_events (
  id            BIGSERIAL PRIMARY KEY,
  raw_job_id    BIGINT REFERENCES raw_job_postings(id) ON DELETE SET NULL,
  job_id        BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  duration_ms   INTEGER,
  error_message TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processing_events_raw ON job_processing_events(raw_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_events_job ON job_processing_events(job_id, created_at DESC);

-- ── user_profiles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID NOT NULL UNIQUE,
  current_title          TEXT,
  total_experience_years NUMERIC(4,1),
  highest_education_level TEXT,
  current_city           TEXT,
  current_state          TEXT,
  current_country       CHAR(2),
  work_authorization     TEXT,
  needs_sponsorship      BOOLEAN,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_target_roles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  canonical_role  TEXT NOT NULL,
  role_family     TEXT,
  priority        SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_skills (
  user_profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  skill_id        BIGINT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency     TEXT,
  years_experience NUMERIC(4,1),
  source          TEXT,
  confidence      REAL,
  PRIMARY KEY (user_profile_id, skill_id)
);

-- Hard vs soft split (see matching/eligibility.mjs, docs/profile-recommendation-model.md):
-- HARD (gate eligibility): remote_only, preferred_employment_types (when
-- non-empty, treated as an allow-list, not a soft nudge — a user who set
-- FULL_TIME here does not want to see CONTRACT roles at all), exclude_clearance_jobs,
-- excluded_companies, excluded_role_families, allowed_countries, max_experience_required,
-- and min_salary ONLY when salary_is_hard_constraint is true.
-- SOFT (affect score only): preferred_workplace_types (unless remote_only),
-- preferred_states, preferred_cities, min_salary when NOT salary_is_hard_constraint.
-- require_sponsorship is legacy-duplicate of user_profiles.needs_sponsorship
-- (that column is authoritative — see Phase 2 audit); kept only for any
-- caller still reading it, always written in sync by the profile API.
CREATE TABLE IF NOT EXISTS user_profile_preferences (
  user_profile_id          UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  preferred_workplace_types TEXT[] DEFAULT '{}',
  preferred_employment_types TEXT[] DEFAULT '{}',
  preferred_states          TEXT[] DEFAULT '{}',
  preferred_cities          TEXT[] DEFAULT '{}',
  remote_only               BOOLEAN NOT NULL DEFAULT FALSE,
  min_salary                INTEGER,
  salary_is_hard_constraint BOOLEAN NOT NULL DEFAULT FALSE,
  max_experience_required   NUMERIC(4,1),
  require_sponsorship       BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_clearance_jobs    BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_companies        TEXT[] DEFAULT '{}',
  excluded_role_families    TEXT[] DEFAULT '{}',
  allowed_countries         TEXT[] DEFAULT '{}',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE user_profile_preferences ADD COLUMN IF NOT EXISTS salary_is_hard_constraint BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_profile_preferences ADD COLUMN IF NOT EXISTS excluded_role_families TEXT[] DEFAULT '{}';
ALTER TABLE user_profile_preferences ADD COLUMN IF NOT EXISTS allowed_countries TEXT[] DEFAULT '{}';

CREATE TABLE IF NOT EXISTS user_job_interactions (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL,
  job_id           BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('VIEW','SAVE','SKIP','APPLY','HIDE','CLICK')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_interactions_user ON user_job_interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_job ON user_job_interactions(job_id);

CREATE TABLE IF NOT EXISTS applications (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                UUID NOT NULL,
  job_id                 BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'SAVED',
  applied_at             TIMESTAMPTZ,
  external_application_id TEXT,
  application_url        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_embeddings (
  job_id          BIGINT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  embedding       JSONB NOT NULL,
  embedding_model TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── scan_runs ───────────────────────────────────────────────
-- Audit log of every scanner run. Used for freshness baseline.
CREATE TABLE IF NOT EXISTS scan_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  companies_scanned INT DEFAULT 0,
  companies_errored INT DEFAULT 0,
  jobs_fetched      INT DEFAULT 0,
  jobs_new          INT DEFAULT 0,
  jobs_reactivated  INT DEFAULT 0,   -- previously closed, now seen again
  jobs_closed       INT DEFAULT 0,   -- marked inactive this run
  status       TEXT DEFAULT 'running'  -- running | completed | failed
);

-- ── user_preferences ────────────────────────────────────────
-- Per-user job matching preferences (standalone — no external system).
CREATE TABLE IF NOT EXISTS user_preferences (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL,          -- this app's own user id
  title_keywords  TEXT[] DEFAULT '{}',    -- e.g. ['software engineer', 'ml engineer']
  locations       TEXT[] DEFAULT '{}',    -- e.g. ['dallas', 'remote']
  remote_only     BOOLEAN DEFAULT FALSE,
  categories      TEXT[] DEFAULT '{"engineering"}',
  exclude_companies TEXT[] DEFAULT '{}',
  min_match_score SMALLINT DEFAULT 50,    -- 0–100
  notify_email    BOOLEAN DEFAULT TRUE,
  notify_push     BOOLEAN DEFAULT TRUE,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prefs_user_id ON user_preferences(user_id);

-- ── user_job_alerts ─────────────────────────────────────────
-- Jobs matched to users. Source of the personalized feed.
CREATE TABLE IF NOT EXISTS user_job_alerts (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL,
  job_id     BIGINT REFERENCES jobs(id) ON DELETE CASCADE,
  pref_id    UUID REFERENCES user_preferences(id) ON DELETE CASCADE,
  score      SMALLINT DEFAULT 0,        -- 0–100 match score
  seen       BOOLEAN DEFAULT FALSE,
  saved      BOOLEAN DEFAULT FALSE,
  applied    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id  ON user_job_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_job_id   ON user_job_alerts(job_id);
CREATE INDEX IF NOT EXISTS idx_alerts_seen     ON user_job_alerts(seen);
CREATE INDEX IF NOT EXISTS idx_alerts_score    ON user_job_alerts(score DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created  ON user_job_alerts(created_at DESC);

-- ── user_keyword_searches ───────────────────────────────────
-- One saved keyword search per user, layered on top of their
-- recommendation feed (matching/keyword-search.mjs). include terms are
-- OR-ed, exclude terms hide a job, scope picks where they match. Saving is
-- validated first: PUT /users/:userId/search refuses a keyword that returns
-- no jobs, so a user can't save themselves into an empty feed.
CREATE TABLE IF NOT EXISTS user_keyword_searches (
  user_id        UUID PRIMARY KEY,
  include_terms  TEXT[] NOT NULL DEFAULT '{}',
  exclude_terms  TEXT[] NOT NULL DEFAULT '{}',
  scope          TEXT NOT NULL DEFAULT 'title'
                 CHECK (scope IN ('title', 'title_description', 'description')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- normalized_title LIKE ANY(...) in keyword title search; the existing
-- idx_jobs_title_trgm only covers the raw title column.
CREATE INDEX IF NOT EXISTS idx_jobs_normalized_title_trgm ON jobs USING GIN (normalized_title gin_trgm_ops);

-- Applications tracker (dashboard /applications). Free-text notes per
-- application; status values used by the API: SAVED, APPLIED, INTERVIEWING,
-- OFFER, REJECTED, ARCHIVED.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE INDEX IF NOT EXISTS idx_applications_user_status ON applications(user_id, status, updated_at DESC);

-- Dashboard profile header (public/app): contact details + summary shown on
-- the Profile screen. Not used by matching.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS full_name    TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email        TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS summary      TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS open_to_work BOOLEAN DEFAULT TRUE;

-- ── resume_profiles ─────────────────────────────────────────
-- Named resume profiles per user (lib/resume-profiles.mjs, docs/profile.md).
-- `sections` holds personal info, summary, education, experience, projects,
-- skills, certifications, custom sections and application defaults as JSON
-- (validated in lib/resume-profiles.mjs). The default profile is synced into
-- user_profiles / user_skills for matching.
CREATE TABLE IF NOT EXISTS resume_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL,
  name            TEXT NOT NULL,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  sections        JSONB NOT NULL DEFAULT '{}'::jsonb,
  cover_letter    TEXT,
  resume_text     TEXT,
  resume_filename TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resume_profiles_user ON resume_profiles(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_profiles_one_default ON resume_profiles(user_id) WHERE is_default;
-- Page layout of the profile's resume (lib/resume-layout.mjs): template, font,
-- size, alignment, fit to one page, section order/visibility, header links.
ALTER TABLE resume_profiles ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The resume file as uploaded (PDF, Word or text), so it can be downloaded again.
CREATE TABLE IF NOT EXISTS resume_files (
  profile_id   UUID PRIMARY KEY REFERENCES resume_profiles(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  name         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data         BYTEA NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Application records keep what was applied to (docs/auto-apply.md) ──────
-- job_snapshot freezes the posting (title, company, location, url, salary,
-- description) when the job is tracked and again when it moves to APPLIED,
-- because scans overwrite jobs.description and a job row can disappear.
-- application_events is the status history. The resume and cover letter that
-- were actually sent are stored per application.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS job_snapshot JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';   -- manual | auto
ALTER TABLE applications ADD COLUMN IF NOT EXISTS resume_profile_id UUID;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lane_id UUID;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS tailored_resume JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS cover_letter TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS answers JSONB;
-- Auto-apply pipeline state, separate from the tracker status:
-- QUEUED → PREPARED → (NEEDS_REVIEW) → SUBMITTING → SUBMITTED | NEEDS_YOU | FAILED | SKIPPED
ALTER TABLE applications ADD COLUMN IF NOT EXISTS apply_state TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS apply_detail JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_applications_user_job ON applications(user_id, job_id);
CREATE INDEX IF NOT EXISTS idx_applications_apply_state ON applications(apply_state) WHERE apply_state IS NOT NULL;

UPDATE applications a
   SET job_snapshot = jsonb_build_object(
         'title', j.title, 'company', j.company, 'location', j.location, 'url', j.url, 'ats', j.ats,
         'workplace', j.workplace_type, 'employmentType', j.employment_type,
         'salaryMinAnnual', j.salary_min_annual, 'salaryMaxAnnual', j.salary_max_annual,
         'postedAt', j.posted_at, 'description', COALESCE(NULLIF(j.description_clean, ''), j.description),
         'capturedAt', NOW())
  FROM jobs j
 WHERE a.job_id = j.id AND a.job_snapshot IS NULL;

CREATE TABLE IF NOT EXISTS application_events (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  kind           TEXT NOT NULL DEFAULT 'status',   -- status | auto_apply | note
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id, created_at);

-- ─── Auto-apply settings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_apply_settings (
  user_id                UUID PRIMARY KEY,
  enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  daily_cap              INT NOT NULL DEFAULT 25,
  per_company_cap_30d    INT NOT NULL DEFAULT 3,
  -- Tick required "I agree / I acknowledge" boxes on forms. Off until the person turns it on.
  accept_consent         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE auto_apply_settings ADD COLUMN IF NOT EXISTS accept_consent BOOLEAN NOT NULL DEFAULT FALSE;

-- A lane = one kind of role, one resume profile, its own rules.
CREATE TABLE IF NOT EXISTS auto_apply_lanes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL,
  name                 TEXT NOT NULL,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  resume_profile_id    UUID REFERENCES resume_profiles(id) ON DELETE SET NULL,
  min_score            INT NOT NULL DEFAULT 70,
  search               TEXT,             -- include terms, | separated, matched in title
  exclude_search       TEXT,             -- exclude terms, | separated, matched in title and description
  exclude_title        TEXT NOT NULL DEFAULT 'senior|sr.|staff|principal|lead|manager|director|head of|vp',
  workplace_types      TEXT[] NOT NULL DEFAULT '{}',
  posted_within_days   INT NOT NULL DEFAULT 14,
  tailor_mode          TEXT NOT NULL DEFAULT 'match',    -- off | honest | ai | match (docs/resume-model.md)
  review_before_submit BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_apply_lanes_user ON auto_apply_lanes(user_id);

CREATE TABLE IF NOT EXISTS auto_apply_runs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  dry_run     BOOLEAN NOT NULL DEFAULT FALSE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  summary     JSONB
);
CREATE INDEX IF NOT EXISTS idx_auto_apply_runs_user ON auto_apply_runs(user_id, started_at DESC);

-- ─── Resume rewrites: every tailored resume, kept as training data ─────────
-- (docs/resume-model.md). One row per tailoring of one application: the
-- posting, the resume going in, the resume that came out, the rewrite report
-- (with block-level input/output for the model), whether it was sent and how
-- the application turned out. source 'tsenta' rows come from the Tsenta import
-- and have no resume_before; the dataset export aligns them to your profile and
-- drops any bullet that claims something your profile doesn't show.
CREATE TABLE IF NOT EXISTS resume_rewrites (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL,
  application_id   BIGINT REFERENCES applications(id) ON DELETE SET NULL,
  source           TEXT NOT NULL DEFAULT 'app',     -- app | tsenta | manual (your own before → after examples)
  mode             TEXT,                            -- off | honest | ai | tsenta
  model            TEXT,
  job_title        TEXT,
  company          TEXT,
  job_description  TEXT,
  resume_before    JSONB,
  resume_after     JSONB NOT NULL,
  report           JSONB,
  sent             BOOLEAN NOT NULL DEFAULT FALSE,
  outcome          TEXT,                            -- latest tracker status after sending
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resume_rewrites_user ON resume_rewrites(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resume_rewrites_app ON resume_rewrites(application_id);

-- Imported applications (Tsenta history) are matched by their external id so
-- re-running the import updates instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_source_ext
  ON applications(user_id, source, external_application_id) WHERE external_application_id IS NOT NULL;

-- "Match the job" (lib/resume-match.mjs) is the default tailoring for new lanes.
ALTER TABLE auto_apply_lanes ALTER COLUMN tailor_mode SET DEFAULT 'match';
