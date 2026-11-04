/**
 * scanner/worker.mjs
 *
 * Processes ONE company: fetch all jobs → upsert to PostgreSQL.
 * Returns a per-company result object consumed by the orchestrator.
 *
 * PERFORMANCE — fingerprint-skip:
 *   Before classifying any job, we load the set of fingerprints already
 *   stored for this company (one cheap SELECT). Jobs whose fingerprint
 *   hasn't changed since the last scan only need a lightweight last_seen
 *   touch — no ML classification call, no GIN/trigram index rebuild.
 *   On a typical scan 85–90% of jobs are unchanged, so this cuts:
 *     • ML classify calls by ~85–90%
 *     • batchUpsertJobs rows by ~85–90%
 *     • GIN index maintenance almost completely
 *   New or changed jobs still go through the full classify → upsert path.
 */

import { query, batchUpsertJobs, batchUpsertRawJobPostings, upsertJobSources, upsertJobClassifications, replaceJobLocations, recordProcessingEvents, updateStructuredJobFields, updateEligibilityFields, upsertExtractedSkills } from '../lib/db.mjs';
import { computeFingerprint, computeTitleFingerprint, computeDescriptionHash, computeContentHash } from '../lib/fingerprint.mjs';
import { smartClassify } from '../lib/ml-classify.mjs';
import { isJobInCoverage } from '../lib/geo.mjs';
import { normalizeJob } from '../lib/normalize.mjs';
import { extractSkills } from '../lib/skill-extract.mjs';
import { classifySeniority } from '../lib/seniority.mjs';
import { classifyExperience, EXPERIENCE_EXTRACTOR_VERSION } from '../lib/experience.mjs';
import { classifyEducation, EDUCATION_EXTRACTOR_VERSION } from '../lib/education.mjs';
import { classifySponsorship, classifyCitizenship, classifyClearance, SPONSORSHIP_EXTRACTOR_VERSION, CITIZENSHIP_EXTRACTOR_VERSION, CLEARANCE_EXTRACTOR_VERSION } from '../lib/work-eligibility.mjs';
import { parseSalary, annualizeSalary, SALARY_EXTRACTOR_VERSION } from '../lib/salary-extract.mjs';
import { parseLocations, LOCATION_EXTRACTOR_VERSION } from '../lib/location.mjs';

const ELIGIBILITY_EXTRACTION_VERSION = [
  EXPERIENCE_EXTRACTOR_VERSION, EDUCATION_EXTRACTOR_VERSION, SPONSORSHIP_EXTRACTOR_VERSION,
  CITIZENSHIP_EXTRACTOR_VERSION, CLEARANCE_EXTRACTOR_VERSION, SALARY_EXTRACTOR_VERSION, LOCATION_EXTRACTOR_VERSION,
].join('+');

function extractDescription(raw) {
  if (!raw || typeof raw !== 'object') return '';
  return raw.description ?? raw.descriptionHtml ?? raw.content ??
         raw.full_description ?? raw.body ?? '';
}

function extractExternalJobId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['id', 'jobId', 'job_id', 'requisitionId', 'requisition_id', 'reqId', 'postingId', 'positionId', 'externalPath']) {
    if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) return String(raw[key]);
  }
  return null;
}

// Provider registry
import { fetchAll as greenhouse }      from '../providers/greenhouse.mjs';
import { fetchAll as ashby }           from '../providers/ashby.mjs';
import { fetchAll as lever }           from '../providers/lever.mjs';
import { fetchAll as workday }         from '../providers/workday.mjs';
import { fetchAll as bamboohr }        from '../providers/bamboohr.mjs';
import { fetchAll as workable }        from '../providers/workable.mjs';
import { fetchAll as smartrecruiters } from '../providers/smartrecruiters.mjs';
import { fetchAll as recruitee }       from '../providers/recruitee.mjs';
import { fetchAll as breezy }          from '../providers/breezy.mjs';
import { fetchAll as pinpoint }        from '../providers/pinpoint.mjs';
import { fetchAll as rippling }        from '../providers/rippling.mjs';
import { fetchAll as teamtailor }      from '../providers/teamtailor.mjs';
import { fetchAll as oraclecloud }     from '../providers/oraclecloud.mjs';
import { fetchAll as dover }           from '../providers/dover.mjs';

export const PROVIDERS = {
  greenhouse,
  ashby,
  lever,
  workday,
  bamboohr,
  workable,
  smartrecruiters,
  // Added 2026-10-23 (docs/job-sourcing.md): ATSes seen in Tsenta's crawled
  // feed with public, auth-free board APIs, each verified against a live board.
  recruitee,
  breezy,
  pinpoint,
  rippling,
  teamtailor,
  oraclecloud,
  dover,
  // Jobs added by pasting a link on any other site (lib/job-import.mjs). Never scanned: the company row is inactive.
  manual: async () => [],
};

/**
 * Process one company row from the companies table.
 *
 * Returns { companyId, fetched, newJobs, reactivated, unchanged, error }
 * Note: does NOT call touchCompany — the orchestrator batches those.
 */
export async function processCompany(company, opts = {}) {
  const result = {
    companyId:   company.id,
    fetched:     0,
    newJobs:     0,
    reactivated: 0,
    unchanged:   0,
    error:       null,
  };

  const provider = PROVIDERS[company.ats];
  if (!provider) {
    result.error = `Unknown ATS: ${company.ats}`;
    return result;
  }

  // ── 1. Fetch from ATS ──────────────────────────────────────────────────────
  let jobs;
  try {
    // opts.prefetchedJobs: lib/job-import.mjs has already fetched the board
    // to locate the pasted job — reuse it instead of fetching twice.
    // Quick scans: newest-first boards stop paging once a whole page is jobs we already have.
    // "New" must match what gets saved: jobs are keyed by fingerprint (company + title, so one row per
    // title across cities), and out-of-region jobs are dropped below. Matching by URL kept every page "new".
    let isNew;
    if (opts.quick && company.ats === 'oraclecloud') {
      const { rows } = await query(`SELECT fingerprint FROM jobs WHERE company_id = $1 AND active`, [company.id]);
      const known = new Set(rows.map(r => r.fingerprint));
      isNew = (job) => isJobInCoverage(job) && !known.has(computeFingerprint(job));
    }
    jobs = opts.prefetchedJobs ?? await provider(company, { verbose: opts.verbose, isNew });
    result.truncated = !!jobs?.truncated;   // partial list: freshness must not count its missing jobs as gone
  } catch (err) {
    result.error = err.message;
    return result;
  }

  // A board can list one posting several times (Rippling: once per location, same URL); a duplicate
  // URL inside one batch makes the upsert fail with "cannot affect row a second time".
  jobs = [...new Map(jobs.map((job) => [job.url, job])).values()];

  // Keep only jobs in a covered region (US + Canada + EU + Australia by
  // default; set JOB_REGIONS to change). Unclassifiable locations are kept.
  jobs = jobs.filter((job) => isJobInCoverage(job));
  result.fetched = jobs.length;

  if (opts.dryRun) {
    if (opts.verbose) console.error(`  [DRY] ${company.name}: ${jobs.length} jobs`);
    return result;
  }

  if (jobs.length === 0) return result;

  // Save provider payloads before classification so enrichment can be rerun
  // without fetching the source again.
  const rawItems = jobs
    .filter(job => job.url)
    .map(job => {
      const description = extractDescription(job.raw);
      return {
        source: company.ats,
        externalJobId: extractExternalJobId(job.raw),
        job,
        description,
        contentHash: computeContentHash(job, description),
      };
    });
  let rawRows = [];
  try {
    rawRows = await batchUpsertRawJobPostings(rawItems);
  } catch (err) {
    result.error = `raw upsert failed: ${err.message}`;
    if (opts.verbose) console.error(`  ✗ raw upsert [${company.name}]: ${err.message}`);
    return result;
  }
  const rawIdsByUrl = new Map(rawRows.map(row => [row.url, row.id]));

  // ── 2. Load known fingerprints for this company (one query) ───────────────
  // Fingerprints of currently-active jobs that are already in the DB.
  // Jobs whose fp is in this set are "unchanged" — only need a last_seen touch.
  let knownJobs = new Map();
  try {
    const { rows } = await query(
      `SELECT fingerprint, description_hash FROM jobs WHERE company_id = $1 AND active = TRUE`,
      [company.id]
    );
    knownJobs = new Map(rows.map(row => [row.fingerprint, row]));
  } catch (err) {
    // Non-fatal: if we can't load known content, treat everything as new (safe fallback)
    if (opts.verbose) console.error(`  ⚠ ${company.name}: could not load known fps: ${err.message}`);
  }

  // ── 3. Split: unchanged vs new/changed ────────────────────────────────────
  const unchangedFps = [];   // fps of jobs that haven't changed — just touch last_seen
  const toUpsert     = [];   // items for full classify → upsert path

  for (const job of jobs) {
    if (!job.url) continue;
    const fp = computeFingerprint(job);
    const desc = extractDescription(job.raw);
    const descriptionHash = computeDescriptionHash(desc);
    const known = knownJobs.get(fp);

    if (known && known.description_hash === descriptionHash) {
      // Same identity and description — just renew last_seen.
      unchangedFps.push(fp);
    } else {
      // New URL, changed title/description, or reactivated inactive job.
      toUpsert.push({ job, fp, desc, descriptionHash, rawJobId: rawIdsByUrl.get(job.url) ?? null });
    }
  }

  result.unchanged = unchangedFps.length;

  // ── 4. Bulk-touch unchanged jobs (no index rebuild, no ML call) ───────────
  if (unchangedFps.length > 0) {
    try {
      await query(
        `UPDATE jobs
            SET last_seen    = NOW(),
                missed_scans = 0
          WHERE fingerprint   = ANY($1::text[])
            AND company_id    = $2
            AND active        = TRUE`,
        [unchangedFps, company.id]
      );
    } catch (err) {
      if (opts.verbose) console.error(`  ⚠ ${company.name}: touch-unchanged failed: ${err.message}`);
      // Still upsert new/changed jobs below, but the company must not count as cleanly scanned: its jobs
      // kept their old last_seen, and freshness would read every one of them as gone (POET: 80 live jobs).
      result.error = `touch-unchanged failed: ${err.message}`;
    }
  }

  // ── 5. Classify + upsert only new/changed jobs ────────────────────────────
  if (toUpsert.length > 0) {
    const prepared = [];
    for (const { job, fp, desc, descriptionHash, rawJobId } of toUpsert) {
      const titleFp = computeTitleFingerprint(job);
      const { category, source: categorySource } = await smartClassify(job.title, desc);
      const canonical = normalizeJob(job, category);
      const experience = classifyExperience(canonical.descriptionClean, job.title);
      const education = classifyEducation(canonical.descriptionClean);
      const sponsorship = classifySponsorship(canonical.descriptionClean);
      const citizenship = classifyCitizenship(canonical.descriptionClean);
      const clearance = classifyClearance(canonical.descriptionClean);
      const salary = parseSalary(canonical.descriptionClean);
      const salaryAnnual = annualizeSalary(salary.min, salary.max, salary.period);
      const locations = parseLocations(job.location);
      const seniority = classifySeniority(job, canonical.descriptionClean, experience.min);
      // Feed the result into fields so updateStructuredJobFields (below)
      // persists it on jobs.seniority_level in the same UPDATE as the rest
      // of the structured fields — no extra round trip.
      canonical.fields.seniorityLevel = seniority.level;
      prepared.push({
        job, companyId: company.id, fp, titleFp, category, categorySource, description: desc, descriptionHash, rawJobId,
        canonical, seniority, experience, education, sponsorship, citizenship, clearance, salary, salaryAnnual, locations,
      });
    }

    try {
      const rows = await batchUpsertJobs(prepared);
      const preparedByUrl = new Map(prepared.map(item => [item.job.url, item]));
      const enrichment = rows.map(row => {
        const item = preparedByUrl.get(row.url);
        return {
          jobId: row.id, rawJobId: item.rawJobId, fields: item.canonical.fields,
          location: item.canonical.location, locations: item.locations, descriptionClean: item.canonical.descriptionClean,
          experience: item.experience, education: item.education, sponsorship: item.sponsorship,
          citizenship: item.citizenship, clearance: item.clearance, salary: item.salary, salaryAnnual: item.salaryAnnual,
        };
      });
      await updateStructuredJobFields(enrichment);
      await updateEligibilityFields(enrichment.map(item => ({
        jobId: item.jobId,
        fields: {
          expMin: item.experience.min,
          expMax: item.experience.max,
          expRequirementType: item.experience.requirementType,
          educationLevel: item.education.level,
          educationRequirement: item.education.requirement,
          educationEquivalentExperience: item.education.equivalentExperienceAccepted,
          sponsorshipStatus: item.sponsorship.status,
          citizenshipRequirement: item.citizenship.required,
          itarRelated: item.citizenship.itarRelated,
          clearanceType: item.clearance.type,
          clearanceRequirement: item.clearance.requirement,
          salaryMinRaw: item.salary.min,
          salaryMaxRaw: item.salary.max,
          salaryPeriod: item.salary.period,
          salaryMinAnnual: item.salaryAnnual.min,
          salaryMaxAnnual: item.salaryAnnual.max,
          eligibilityExtractionVersion: ELIGIBILITY_EXTRACTION_VERSION,
        },
      })));
      // locations is 0+ entries per job (multi-location postings); jobs
      // with no parseable location string simply contribute no rows.
      await replaceJobLocations(enrichment.flatMap(item => item.locations.map((loc, index) => ({
        jobId: item.jobId,
        city: loc.city,
        stateCode: loc.stateCode,
        countryCode: loc.countryCode,
        isPrimary: index === 0,
        isRemoteRestriction: loc.isRemote,
        region: loc.region,
      }))));
      await recordProcessingEvents(enrichment.map(item => ({
        rawJobId: item.rawJobId,
        jobId: item.jobId,
        stage: 'NORMALIZE',
        status: 'COMPLETED',
        metadata: { version: 'deterministic-normalizer-v1' },
      })));
      await upsertExtractedSkills(enrichment.map(item => ({
        jobId: item.jobId,
        skills: extractSkills(item.descriptionClean || ''),
      })));
      await upsertJobSources(rows.map(row => {
        const item = preparedByUrl.get(row.url);
        return {
          jobId: row.id,
          rawJobId: item.rawJobId,
          source: company.ats,
          externalJobId: extractExternalJobId(item.job.raw),
          url: item.job.url,
          atsType: company.ats,
        };
      }));
      await upsertJobClassifications(rows.flatMap(row => {
        const item = preparedByUrl.get(row.url);
        return [
          {
            jobId: row.id,
            fieldName: 'category',
            value: item.category,
            version: `category-${item.categorySource}-v1`,
            evidence: item.job.title,
          },
          {
            jobId: row.id,
            fieldName: 'role_family',
            value: item.canonical.roleFamily,
            version: 'role-family-normalizer-v1',
            evidence: item.job.title,
          },
          {
            jobId: row.id,
            fieldName: 'seniority_level',
            value: item.seniority.level,
            confidence: item.seniority.confidence,
            version: item.seniority.classifierVersion,
            evidence: item.seniority.evidence,
          },
          { jobId: row.id, fieldName: 'experience', value: `${item.experience.min ?? ''}-${item.experience.max ?? ''}`, confidence: item.experience.confidence, version: item.experience.extractorVersion, evidence: item.experience.evidence },
          { jobId: row.id, fieldName: 'education_level', value: item.education.level, confidence: item.education.confidence, version: item.education.extractorVersion, evidence: item.education.evidence },
          { jobId: row.id, fieldName: 'sponsorship_status', value: item.sponsorship.status, confidence: item.sponsorship.confidence, version: item.sponsorship.extractorVersion, evidence: item.sponsorship.evidence },
          { jobId: row.id, fieldName: 'citizenship_requirement', value: item.citizenship.required, confidence: item.citizenship.confidence, version: item.citizenship.extractorVersion, evidence: item.citizenship.evidence },
          { jobId: row.id, fieldName: 'clearance_type', value: item.clearance.type, confidence: item.clearance.confidence, version: item.clearance.extractorVersion, evidence: item.clearance.evidence },
          { jobId: row.id, fieldName: 'salary', value: `${item.salary.min ?? ''}-${item.salary.max ?? ''} ${item.salary.period ?? ''}`.trim(), confidence: item.salary.confidence, version: item.salary.extractorVersion, evidence: item.salary.evidence },
        ];
      }));
      for (const row of rows) {
        if (row.isNew)       result.newJobs++;
        if (row.reactivated) result.reactivated++;
      }
    } catch (err) {
      result.error = `batch upsert failed: ${err.message}`;
      if (opts.verbose) console.error(`  ✗ batch upsert [${company.name}]: ${err.message}${err.where ? ` @ ${err.where.slice(0, 200)}` : ''}${err.column ? ` col=${err.column}` : ''}${err.table ? ` table=${err.table}` : ''}`);
      return result;
    }
  }

  return result;
}
