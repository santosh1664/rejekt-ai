/**
 * db/add-filters.mjs
 *
 * Migration: Add ML-extracted filter columns to the jobs table.
 * Enums use unambiguous string values (stored as TEXT with CHECK constraints).
 *
 * Usage:
 *   node --env-file=.env.local db/add-filters.mjs
 */
import { query, closePool } from '../lib/db.mjs';

async function run() {
  console.log('=== add-filters migration ===\n');

  // ── 1. Career / experience level ──────────────────────────────────────────
  console.log('1/12  career_level column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS career_level TEXT
    CHECK (career_level IN ('INTERN','ENTRY','MID','SENIOR','LEAD','MANAGER','EXECUTIVE','UNKNOWN'))
    DEFAULT 'UNKNOWN'`);

  // ── 2. Years of experience ─────────────────────────────────────────────────
  console.log('2/12  experience years columns…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS min_exp_years SMALLINT`);
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_exp_years SMALLINT`);

  // ── 3. Degree requirement (JSONB: {degree, requirement}) ───────────────────
  console.log('3/12  degree_required column (JSONB array)…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS degree_required JSONB DEFAULT '[]'::jsonb`);
  // Each element: { "degree": "BACHELOR|MASTER|PHD|ASSOCIATE|NONE", "requirement": "REQUIRED|PREFERRED|NOT_MENTIONED" }

  // ── 4. Visa sponsorship ────────────────────────────────────────────────────
  console.log('4/12  sponsorship_status column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sponsorship_status TEXT
    CHECK (sponsorship_status IN ('AVAILABLE','NOT_AVAILABLE','RESTRICTED','NOT_MENTIONED','UNCLEAR'))
    DEFAULT 'NOT_MENTIONED'`);

  // ── 5. Employment type ─────────────────────────────────────────────────────
  console.log('5/12  employment_type column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employment_type TEXT
    CHECK (employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','TEMPORARY','INTERNSHIP','UNKNOWN'))
    DEFAULT 'UNKNOWN'`);

  // ── 6. Workplace type (replaces boolean remote with richer enum) ───────────
  console.log('6/12  workplace_type column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workplace_type TEXT
    CHECK (workplace_type IN ('REMOTE','HYBRID','ONSITE','FLEXIBLE','UNKNOWN'))
    DEFAULT 'UNKNOWN'`);

  // ── 7. Salary ──────────────────────────────────────────────────────────────
  console.log('7/12  salary columns…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min_annual INTEGER`);
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max_annual INTEGER`);
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_currency TEXT DEFAULT 'USD'`);

  // ── 8. Skills array ────────────────────────────────────────────────────────
  console.log('8/12  skill_tags column…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS skill_tags TEXT[] DEFAULT '{}'`);

  // ── 9. Extraction metadata ─────────────────────────────────────────────────
  console.log('9/12  extraction metadata columns…');
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS extraction_confidence REAL`);
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS extraction_version TEXT`);
  await query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_hash TEXT`);

  // ── 10. Posted date bucket for fast filtering ──────────────────────────────
  console.log('10/12  date bucket index…');
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs (posted_at DESC NULLS LAST) WHERE active = TRUE`);

  // ── 11. Indexes for new filter columns ────────────────────────────────────
  console.log('11/12  Creating indexes on filter columns…');
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_career_level       ON jobs (career_level)       WHERE active = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_employment_type    ON jobs (employment_type)    WHERE active = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_workplace_type     ON jobs (workplace_type)     WHERE active = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_sponsorship_status ON jobs (sponsorship_status) WHERE active = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_salary_min         ON jobs (salary_min_annual)  WHERE active = TRUE AND salary_min_annual IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_skill_tags         ON jobs USING GIN (skill_tags) WHERE active = TRUE`);

  // ── 12. Backfill workplace_type from existing remote boolean ──────────────
  console.log('12/12  Backfilling workplace_type from remote boolean…');
  const { rowCount } = await query(`
    UPDATE jobs
    SET workplace_type = CASE
      WHEN remote = TRUE  THEN 'REMOTE'
      WHEN remote = FALSE THEN 'ONSITE'
      ELSE 'UNKNOWN'
    END
    WHERE workplace_type = 'UNKNOWN' OR workplace_type IS NULL
  `);
  console.log(`   → ${rowCount} rows backfilled from remote column`);

  console.log('\n✓  add-filters migration complete.');
  console.log('Next step: run  python3 ml/extract_fields.py  to populate ML fields.\n');
  await closePool();
}

run().catch((e) => { console.error(e); process.exit(1); });
