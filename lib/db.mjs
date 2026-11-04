/**
 * lib/db.mjs
 *
 * PostgreSQL connection pool + query helpers.
 * Single pool instance shared across the process (singleton).
 */

import pg from 'pg';
import { skillExtractorVersion } from './skill-extract.mjs';
const { Pool } = pg;

let _pool = null;

/**
 * Get (or create) the shared connection pool.
 * Reads DATABASE_URL from environment.
 */
export function getPool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  _pool = new Pool({
    // Append statement_timeout as a session option so it is set at
    // connection startup — avoids the pg 'already executing' warning
    // that fires when we call client.query() inside pool.on('connect').
    connectionString: url.includes('options=') ? url
      : (url.includes('?') ? url + '&' : url + '?') +
        `options=-c%20statement_timeout%3D${encodeURIComponent(process.env.DB_STATEMENT_TIMEOUT || '30000')}`,
    max:              70,    // max connections in pool (raised to match higher worker counts;
                              // RDS max_connections=181, confirmed only ~11 in use across all
                              // processes when idle, so this leaves headroom for server.mjs's
                              // own separate pool + watchdog.mjs running concurrently)
    idleTimeoutMillis: 10_000,   // recycle idle sockets before the NAT/router silently drops them (ETIMEDOUT)
    connectionTimeoutMillis: 5_000,
    // TCP keepalive — detects dead connections to RDS before they cause hangs
    // statement_timeout is injected into the connection string above
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });

  _pool.on('error', (err) => {
    console.error('[db] Pool error:', err.message);
  });

  return _pool;
}

/**
 * Run a query and return all rows.
 */
export async function query(sql, params = []) {
  try {
    return await getPool().query(sql, params);
  } catch (err) {
    // ponytail: one retry on a dead socket; a write could in theory run twice, fine for our upserts
    if (!/ETIMEDOUT|ECONNRESET|Connection terminated/.test(err.message)) throw err;
    return getPool().query(sql, params);
  }
}

/** For the few big read queries that legitimately run past the pool's 30s statement_timeout. */
export async function slowQuery(sql, params = [], timeout = '600s') {
  const client = await getPool().connect();
  try { await client.query(`SET statement_timeout = '${timeout}'`); return (await client.query(sql, params)).rows; }
  finally { await client.query('RESET statement_timeout').catch(() => {}); client.release(); }
}

/**
 * Preserve provider payloads before canonical classification and enrichment.
 * The source URL is the current exact-source identity; external IDs remain
 * available for stronger adapter-specific deduplication later.
 */
export async function batchUpsertRawJobPostings(items) {
  if (items.length === 0) return [];

  const results = [];
  const CHUNK = 100;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const rows = slice.map((_, idx) => {
      const b = idx * 12;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`;
    }).join(',');
    const params = slice.flatMap(({ source, externalJobId, job, description, contentHash }) => [
      source,
      externalJobId || null,
      job.url,
      job.company || '',
      job.title || '',
      job.location || '',
      description || '',
      job.raw?.salary || job.raw?.salaryText || null,
      job.raw?.employmentType || job.raw?.employment_type || null,
      job.posted_at || null,
      JSON.stringify(job.raw ?? {}),
      contentHash,
    ]);

    const res = await query(
      `INSERT INTO raw_job_postings
         (source, external_job_id, url, company_raw, title_raw, location_raw,
          description_raw, salary_raw, employment_type_raw, posted_at_raw,
          payload, content_hash)
       VALUES ${rows}
       ON CONFLICT (source, url) DO UPDATE SET
         external_job_id = EXCLUDED.external_job_id,
         company_raw = EXCLUDED.company_raw,
         title_raw = EXCLUDED.title_raw,
         location_raw = EXCLUDED.location_raw,
         description_raw = EXCLUDED.description_raw,
         salary_raw = EXCLUDED.salary_raw,
         employment_type_raw = EXCLUDED.employment_type_raw,
         posted_at_raw = EXCLUDED.posted_at_raw,
         payload = EXCLUDED.payload,
         content_hash = EXCLUDED.content_hash,
         processing_status = CASE
           WHEN raw_job_postings.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 'RAW'
           ELSE raw_job_postings.processing_status
         END,
         processing_error = CASE
           WHEN raw_job_postings.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
           ELSE raw_job_postings.processing_error
         END,
         last_seen_at = NOW(),
         scraped_at = NOW()
       RETURNING id, url`,
      params
    );
    results.push(...res.rows);
  }
  return results;
}

/** Keep the source-to-canonical relationship current after a job upsert. */
export async function upsertJobSources(items) {
  if (items.length === 0) return;

  const rows = items.map((_, idx) => {
    const b = idx * 8;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
  }).join(',');
  const params = items.flatMap(({ jobId, rawJobId, source, externalJobId, url, atsType }) => [
    jobId, rawJobId, source, externalJobId || null, url, atsType || source, true, new Date(),
  ]);

  await query(
    `INSERT INTO job_sources
       (job_id, raw_job_id, source, external_job_id, url, ats_type, is_primary, last_seen_at)
     VALUES ${rows}
     ON CONFLICT (source, url) DO UPDATE SET
       job_id = EXCLUDED.job_id,
       raw_job_id = EXCLUDED.raw_job_id,
       external_job_id = EXCLUDED.external_job_id,
       ats_type = EXCLUDED.ats_type,
       is_primary = EXCLUDED.is_primary,
       last_seen_at = EXCLUDED.last_seen_at`,
    params
  );
}

/** Persist explainable classification outputs without blocking the job write. */
export async function upsertJobClassifications(items) {
  if (items.length === 0) return;

  const rows = items.map((_, idx) => {
    const b = idx * 7;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
  }).join(',');
  const params = items.flatMap(({ jobId, fieldName, value, confidence, version, evidence }) => [
    jobId, fieldName, value || null, confidence ?? null, version, evidence || null, new Date(),
  ]);

  await query(
    `INSERT INTO job_classifications
       (job_id, field_name, predicted_value, confidence, classifier_version, evidence, created_at)
     VALUES ${rows}
     ON CONFLICT (job_id, field_name, classifier_version) DO UPDATE SET
       predicted_value = EXCLUDED.predicted_value,
       confidence = EXCLUDED.confidence,
       evidence = EXCLUDED.evidence,
       created_at = EXCLUDED.created_at`,
    params
  );
}

/**
 * Replaces all job_locations rows for the given jobs. `items` may contain
 * more than one entry per jobId — a multi-location posting ("NYC / SF /
 * Remote") produces one row per option (see lib/location.mjs). The first
 * entry for a given jobId is marked primary unless isPrimary is set
 * explicitly.
 */
export async function replaceJobLocations(items) {
  if (items.length === 0) return;
  const jobIds = [...new Set(items.map(item => item.jobId))];
  await query('DELETE FROM job_locations WHERE job_id = ANY($1::bigint[])', [jobIds]);
  const rows = items.map((_, index) => {
    const b = index * 7;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
  }).join(',');
  const seenJob = new Set();
  const params = items.flatMap(({ jobId, city, stateCode, countryCode, isPrimary, isRemoteRestriction, region }) => {
    const primary = isPrimary ?? !seenJob.has(jobId);
    seenJob.add(jobId);
    return [jobId, city || null, stateCode || null, countryCode || null, primary, !!isRemoteRestriction, region || null];
  });
  await query(
    `INSERT INTO job_locations (job_id, city, state_code, country_code, is_primary, is_remote_restriction, region)
     VALUES ${rows}
     ON CONFLICT (job_id, city, state_code, country_code) DO UPDATE
     SET is_primary = EXCLUDED.is_primary, is_remote_restriction = EXCLUDED.is_remote_restriction, region = EXCLUDED.region`,
    params
  );
}

export async function recordProcessingEvents(items) {
  if (items.length === 0) return;
  const rows = items.map((_, index) => {
    const b = index * 7;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
  }).join(',');
  const params = items.flatMap(({ rawJobId, jobId, stage, status, durationMs, errorMessage, metadata }) => [
    rawJobId || null, jobId || null, stage, status, durationMs ?? null, errorMessage || null, JSON.stringify(metadata || {}),
  ]);
  await query(
    `INSERT INTO job_processing_events
       (raw_job_id, job_id, stage, status, duration_ms, error_message, metadata)
     VALUES ${rows}`,
    params
  );
}

// Experience, salary, and sponsorship used to be written here too, from
// lib/normalize.mjs's old regex-based extractStructuredFields. That logic
// has been superseded by lib/experience.mjs, lib/salary-extract.mjs, and
// lib/work-eligibility.mjs (written via updateEligibilityFields below) —
// this function's remaining job is just employment_type and seniority_level.
export async function updateStructuredJobFields(items) {
  if (items.length === 0) return;
  await query(
    `UPDATE jobs AS j SET
       employment_type = u.employment_type,
       seniority_level = u.seniority_level
      FROM UNNEST(
        $1::bigint[], $2::text[], $3::text[]
      ) AS u(id, employment_type, seniority_level)
     WHERE j.id = u.id`,
    [
      items.map(item => item.jobId),
      items.map(item => item.fields.employmentType),
      // seniority_level is authoritative from lib/seniority.mjs's classifier
      // (see scanner/worker.mjs) — defaults to 'UNKNOWN' if not supplied so
      // this function stays usable from any caller that doesn't classify it.
      items.map(item => item.fields.seniorityLevel || 'UNKNOWN'),
    ]
  );
}

/**
 * Writes the structured eligibility fields (experience/education/
 * sponsorship/citizenship/clearance/salary) added for hard-eligibility
 * filtering and recommendation scoring. Kept separate from
 * updateStructuredJobFields (legacy/skills-era fields) rather than growing
 * that function's already-long UNNEST parameter list further.
 *
 * @param {Array<{jobId:number, fields: {
 *   expMin, expMax, expRequirementType,
 *   educationLevel, educationRequirement, educationEquivalentExperience,
 *   citizenshipRequirement, itarRelated,
 *   clearanceType, clearanceRequirement,
 *   salaryMinRaw, salaryMaxRaw, salaryPeriod, salaryMinAnnual, salaryMaxAnnual,
 *   eligibilityExtractionVersion
 * }}>} items
 */
// Defensive clamp for numeric fields written by regex-based extractors —
// three separate out-of-range/non-integer values from real job postings
// (a $37.63/hour rate, "1.5 years", a $220B figure mis-parsed as salary)
// each crashed a whole batch through every retry before being fixed at
// the extractor. Rounding/clamping here is a second line of defense so a
// future extractor edge case degrades to a clamped value instead of
// failing the batch outright.
function safeSmallint(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}
// min_exp_years/max_exp_years are NUMERIC(4,1): anything outside 0–99 is a parse error (e.g. "70,000 years"), not a requirement
function safeExpYears(value) {
  if (value == null || Number.isNaN(value) || value < 0 || value > 99) return null;
  return Math.round(value);
}
function safeInteger(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.max(-2147483648, Math.min(2147483647, Math.round(value)));
}

export async function updateEligibilityFields(items) {
  if (items.length === 0) return;
  await query(
    `UPDATE jobs AS j SET
       min_exp_years = u.exp_min,
       max_exp_years = u.exp_max,
       experience_requirement_type = u.exp_requirement_type,
       education_level = u.education_level,
       education_requirement = u.education_requirement,
       education_equivalent_experience = u.education_equivalent_experience,
       sponsorship_status = u.sponsorship_status,
       citizenship_requirement = u.citizenship_requirement,
       itar_related = u.itar_related,
       clearance_type = u.clearance_type,
       clearance_requirement = u.clearance_requirement,
       salary_min_raw = u.salary_min_raw,
       salary_max_raw = u.salary_max_raw,
       salary_period = u.salary_period,
       salary_min_annual = u.salary_min_annual,
       salary_max_annual = u.salary_max_annual,
       eligibility_extraction_version = u.eligibility_extraction_version
      FROM UNNEST(
        $1::bigint[], $2::smallint[], $3::smallint[], $4::text[],
        $5::text[], $6::text[], $7::boolean[],
        $8::text[],
        $9::text[], $10::boolean[],
        $11::text[], $12::text[],
        $13::integer[], $14::integer[], $15::text[], $16::integer[], $17::integer[],
        $18::text[]
      ) AS u(id, exp_min, exp_max, exp_requirement_type,
             education_level, education_requirement, education_equivalent_experience,
             sponsorship_status,
             citizenship_requirement, itar_related,
             clearance_type, clearance_requirement,
             salary_min_raw, salary_max_raw, salary_period, salary_min_annual, salary_max_annual,
             eligibility_extraction_version)
     WHERE j.id = u.id`,
    [
      items.map(item => item.jobId),
      items.map(item => safeExpYears(item.fields.expMin)),
      items.map(item => safeExpYears(item.fields.expMax)),
      items.map(item => item.fields.expRequirementType || 'UNKNOWN'),
      items.map(item => item.fields.educationLevel || 'UNKNOWN'),
      items.map(item => item.fields.educationRequirement || 'UNKNOWN'),
      items.map(item => !!item.fields.educationEquivalentExperience),
      items.map(item => item.fields.sponsorshipStatus || 'UNKNOWN'),
      items.map(item => item.fields.citizenshipRequirement || null),
      items.map(item => !!item.fields.itarRelated),
      items.map(item => item.fields.clearanceType || 'NONE'),
      items.map(item => item.fields.clearanceRequirement || 'NONE'),
      items.map(item => safeInteger(item.fields.salaryMinRaw)),
      items.map(item => safeInteger(item.fields.salaryMaxRaw)),
      items.map(item => item.fields.salaryPeriod),
      items.map(item => safeInteger(item.fields.salaryMinAnnual)),
      items.map(item => safeInteger(item.fields.salaryMaxAnnual)),
      items.map(item => item.fields.eligibilityExtractionVersion),
    ]
  );
}

/**
 * Upserts extracted skills for a batch of jobs and removes any job_skills
 * rows for those jobs that the current extraction run did NOT reproduce
 * (stale rows from an older extractor version or a since-fixed false
 * positive) — every job in `items` is treated as authoritative for its own
 * full skill set, including jobs whose current extraction is empty.
 * Also stamps jobs.extraction_version so backfills can resume by version.
 *
 * @param {Array<{jobId: number, skills: Array<{name, canonicalName, category, importance, confidence, evidence}>}>} items
 */
export async function upsertExtractedSkills(items) {
  if (items.length === 0) return;

  const distinctSkills = new Map();
  for (const item of items) {
    for (const skill of item.skills) {
      if (!distinctSkills.has(skill.name)) {
        distinctSkills.set(skill.name, { canonicalName: skill.canonicalName || skill.name, category: skill.category || null });
      }
    }
  }

  const skillIdByName = new Map();
  if (distinctSkills.size > 0) {
    const names = [...distinctSkills.keys()];
    const { rows: upserted } = await query(
      `INSERT INTO skills (canonical_name, normalized_name, category)
       SELECT u.canonical_name, u.normalized_name, u.category
         FROM UNNEST($1::text[], $2::text[], $3::text[]) AS u(canonical_name, normalized_name, category)
       ON CONFLICT (normalized_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name, category = EXCLUDED.category
       RETURNING id, normalized_name`,
      [
        names.map(n => distinctSkills.get(n).canonicalName),
        names,
        names.map(n => distinctSkills.get(n).category),
      ]
    );
    for (const row of upserted) skillIdByName.set(row.normalized_name, row.id);
  }

  const keepJobIds = [];
  const keepSkillIds = [];
  const upsertJobIds = [];
  const upsertSkillIds = [];
  const upsertImportance = [];
  const upsertConfidence = [];
  const upsertEvidence = [];
  for (const item of items) {
    for (const skill of item.skills) {
      const skillId = skillIdByName.get(skill.name);
      if (!skillId) continue;
      keepJobIds.push(item.jobId);
      keepSkillIds.push(skillId);
      upsertJobIds.push(item.jobId);
      upsertSkillIds.push(skillId);
      upsertImportance.push(skill.importance);
      upsertConfidence.push(skill.confidence);
      upsertEvidence.push(skill.evidence);
    }
  }

  const allJobIds = items.map(item => item.jobId);

  // Remove obsolete extractor-generated rows: anything previously recorded
  // for these jobs that the current run did not reproduce.
  await query(
    `DELETE FROM job_skills js
      WHERE js.job_id = ANY($1::bigint[])
        AND NOT EXISTS (
          SELECT 1 FROM UNNEST($2::bigint[], $3::bigint[]) AS keep(job_id, skill_id)
          WHERE keep.job_id = js.job_id AND keep.skill_id = js.skill_id
        )`,
    [allJobIds, keepJobIds, keepSkillIds]
  );

  if (upsertJobIds.length > 0) {
    await query(
      `INSERT INTO job_skills (job_id, skill_id, importance, confidence, evidence)
       SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::real[], $5::text[])
       ON CONFLICT (job_id, skill_id) DO UPDATE
       SET importance = EXCLUDED.importance, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence`,
      [upsertJobIds, upsertSkillIds, upsertImportance, upsertConfidence, upsertEvidence]
    );
  }

  await query(
    `UPDATE jobs SET extraction_version = $2 WHERE id = ANY($1::bigint[])`,
    [allJobIds, skillExtractorVersion]
  );
}

/**
 * Upsert a job into the jobs table.
 * On conflict (url): update last_seen, reset missed_scans, reactivate if closed.
 *
 * @param {object} job       — normalised job from a provider
 * @param {number} companyId — FK to companies table
 * @param {string} fp        — computeFingerprint(job)
 * @param {string} titleFp   — computeTitleFingerprint(job)
 * @param {string} category  — classifyCategory(job.title) or smartClassify()'s .category
 * @param {string} [categorySource] — 'keyword' | 'ml' — smartClassify()'s .source (default 'keyword')
 * @returns {{ id: number, isNew: boolean, reactivated: boolean }}
 */
export async function upsertJob(job, companyId, fp, titleFp, category, categorySource = 'keyword', description = '', descriptionHash = null, rawJobId = null, canonical = {}) {
  const res = await query(
    `INSERT INTO jobs
       (url, title, display_title, normalized_title, company, company_id, location, remote, ats,
        fingerprint, title_fp, category, category_source, canonical_role, role_family,
        role_specialization, description_clean, status, workplace_type, posted_at, raw,
        description, description_hash, raw_job_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (url) DO UPDATE SET
       title        = EXCLUDED.title,
      display_title = EXCLUDED.display_title,
      normalized_title = EXCLUDED.normalized_title,
       company      = EXCLUDED.company,
       company_id   = EXCLUDED.company_id,
       location     = EXCLUDED.location,
       remote       = EXCLUDED.remote,
       ats          = EXCLUDED.ats,
       fingerprint  = EXCLUDED.fingerprint,
       title_fp     = EXCLUDED.title_fp,
      raw_job_id   = EXCLUDED.raw_job_id,
       category     = EXCLUDED.category,
       category_source = EXCLUDED.category_source,
      canonical_role = EXCLUDED.canonical_role,
      role_family = EXCLUDED.role_family,
      role_specialization = EXCLUDED.role_specialization,
      description_clean = EXCLUDED.description_clean,
      status = EXCLUDED.status,
      workplace_type = EXCLUDED.workplace_type,
       posted_at    = EXCLUDED.posted_at,
       last_seen    = NOW(),
       missed_scans = 0,
       active       = TRUE,
       closed_at    = CASE WHEN jobs.active = FALSE THEN NULL ELSE jobs.closed_at END,
       raw          = EXCLUDED.raw,
       description  = EXCLUDED.description,
       description_hash = EXCLUDED.description_hash
     RETURNING id,
               (xmax = 0)                   AS is_new,
               (NOT jobs.active AND xmax <> 0) AS reactivated`,
    [
      job.url,
      job.title,
      canonical.displayTitle || job.title,
      canonical.normalizedTitle || null,
      job.company,
      companyId,
      job.location || '',
      job.remote ?? null,
      job.ats,
      fp,
      titleFp,
      category,
      categorySource,
      canonical.canonicalRole || null,
      canonical.roleFamily || null,
      canonical.roleSpecialization || null,
      canonical.descriptionClean || description || '',
      canonical.status || 'READY',
      canonical.workplaceType || null,
      job.posted_at ? new Date(job.posted_at) : null,
      JSON.stringify(job.raw ?? {}),
      description || '',
      descriptionHash,
      rawJobId,
    ]
  );

  const row = res.rows[0];
  return {
    id:          row.id,
    isNew:       row.is_new,
    reactivated: row.reactivated,
  };
}

/**
 * Batch-upsert multiple jobs in a single SQL round-trip.
 * Dramatically faster than looping over upsertJob() for companies with many jobs.
 *
 * @param {{ job, companyId, fp, titleFp, category, categorySource, description, descriptionHash, rawJobId, canonical }[]} items
 * @returns {Promise<{ id, isNew, reactivated }[]>}
 */
export async function batchUpsertJobs(items) {
  if (items.length === 0) return [];

  // PostgreSQL max params = 65535; each job uses 24 → max chunk ≈ 2730.
  // Kept smaller than that ceiling for latency, not packet size: two of the
  // jobs indexes (title trigram + FTS) are GIN, and GIN maintenance for rows
  // whose indexed text actually changed is ~35x slower than a same-value
  // update (measured: 400 real rows ≈ 20s vs <1s for a no-op update of the
  // same size) — a 400-row chunk sits close enough to the pool's 30s
  // statement_timeout that any contention tips it over. 100 gives real margin.
  const CHUNK = 100;
  const results = [];

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice  = items.slice(i, i + CHUNK);
    const rows   = slice.map((_, idx) => {
      const b = idx * 24;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},$${b+19},$${b+20},$${b+21},$${b+22},$${b+23},$${b+24})`;
    }).join(',');
    const params = slice.flatMap(({ job, companyId, fp, titleFp, category, categorySource, description, descriptionHash, rawJobId, canonical = {} }) => [
      job.url,
      job.title,
      canonical.displayTitle || job.title,
      canonical.normalizedTitle || null,
      job.company,
      companyId,
      job.location || '',
      job.remote ?? null,
      job.ats,
      fp,
      titleFp,
      category,
      categorySource || 'keyword',
      canonical.canonicalRole || null,
      canonical.roleFamily || null,
      canonical.roleSpecialization || null,
      canonical.descriptionClean || description || '',
      canonical.status || 'READY',
      canonical.workplaceType || null,
      job.posted_at ? new Date(job.posted_at) : null,
      JSON.stringify(job.raw ?? {}),
      description || '',
      descriptionHash,
      rawJobId,
    ]);

    const res = await query(
      `INSERT INTO jobs
          (url, title, display_title, normalized_title, company, company_id, location, remote, ats,
           fingerprint, title_fp, category, category_source, canonical_role, role_family,
           role_specialization, description_clean, status, workplace_type, posted_at, raw,
           description, description_hash, raw_job_id)
       VALUES ${rows}
       ON CONFLICT (url) DO UPDATE SET
         title           = EXCLUDED.title,
         display_title   = EXCLUDED.display_title,
         normalized_title = EXCLUDED.normalized_title,
         company         = EXCLUDED.company,
         company_id      = EXCLUDED.company_id,
         location        = EXCLUDED.location,
         remote          = EXCLUDED.remote,
         ats             = EXCLUDED.ats,
         fingerprint     = EXCLUDED.fingerprint,
         title_fp        = EXCLUDED.title_fp,
         raw_job_id      = EXCLUDED.raw_job_id,
         category        = EXCLUDED.category,
         category_source = EXCLUDED.category_source,
         canonical_role  = EXCLUDED.canonical_role,
         role_family     = EXCLUDED.role_family,
         role_specialization = EXCLUDED.role_specialization,
         description_clean = EXCLUDED.description_clean,
         status          = EXCLUDED.status,
         workplace_type  = EXCLUDED.workplace_type,
         posted_at       = EXCLUDED.posted_at,
         last_seen       = NOW(),
         missed_scans    = 0,
         active          = TRUE,
         closed_at       = CASE WHEN jobs.active = FALSE THEN NULL ELSE jobs.closed_at END,
         raw             = EXCLUDED.raw,
         description     = EXCLUDED.description,
         description_hash = EXCLUDED.description_hash
       RETURNING id,
                 url,
                 (xmax = 0)                    AS is_new,
                 (NOT jobs.active AND xmax <> 0) AS reactivated`,
      params
    );
    results.push(...res.rows.map(r => ({
      id:          r.id,
      url:         r.url,
      isNew:       r.is_new,
      reactivated: r.reactivated,
    })));
  }

  return results;
}

/**
 * Update a company's last_scan timestamp and reset/increment error count.
 */
export async function touchCompany(companyId, { error = false } = {}) {
  if (error) {
    await query(
      `UPDATE companies SET
         last_scan   = NOW(),
         scan_errors = scan_errors + 1,
         active      = CASE WHEN scan_errors + 1 >= 5 THEN FALSE ELSE active END
       WHERE id = $1`,
      [companyId]
    );
  } else {
    await query(
      `UPDATE companies SET last_scan = NOW(), scan_errors = 0 WHERE id = $1`,
      [companyId]
    );
  }
}

/**
 * Start a new scan_run row; returns the run id.
 */
export async function startScanRun() {
  const res = await query(
    `INSERT INTO scan_runs (status) VALUES ('running') RETURNING id`
  );
  return res.rows[0].id;
}

/**
 * Finish a scan_run row with final counts.
 * @param {string} [status='completed'] — pass 'failed' to record a crashed
 *   run (with whatever partial counts were accumulated) instead of leaving
 *   it stuck at 'running' forever with no finished_at.
 */
export async function finishScanRun(runId, counts, status = 'completed') {
  await query(
    `UPDATE scan_runs SET
       finished_at        = NOW(),
       status             = $8,
       companies_scanned  = $2,
       companies_errored  = $3,
       jobs_fetched       = $4,
       jobs_new           = $5,
       jobs_reactivated   = $6,
       jobs_closed        = $7
     WHERE id = $1`,
    [
      runId,
      counts.companiesScanned,
      counts.companiesErrored,
      counts.jobsFetched,
      counts.jobsNew,
      counts.jobsReactivated,
      counts.jobsClosed,
      status,
    ]
  );
}

/**
 * Batch-update last_scan (and scan_errors) for many companies in two queries
 * instead of N individual touchCompany() calls.
 *
 * @param {number[]} successIds  — company ids that scanned without error
 * @param {number[]} errorIds    — company ids whose fetch/upsert failed
 */
export async function batchTouchCompanies(successIds = [], errorIds = []) {
  if (successIds.length > 0) {
    await query(
      `UPDATE companies
          SET last_scan   = NOW(),
              scan_errors = 0
        WHERE id = ANY($1::int[])`,
      [successIds]
    );
  }
  if (errorIds.length > 0) {
    await query(
      `UPDATE companies
          SET last_scan   = NOW(),
              scan_errors = LEAST(scan_errors + 1, 5),
              active      = CASE WHEN scan_errors + 1 >= 5 THEN FALSE ELSE active END
        WHERE id = ANY($1::int[])`,
      [errorIds]
    );
  }
}

/**
 * Close the pool — call at process exit.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
