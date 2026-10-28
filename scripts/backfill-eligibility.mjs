/**
 * scripts/backfill-eligibility.mjs
 *
 * (Re)runs experience/education/sponsorship/citizenship/clearance/salary/
 * location extraction for existing jobs and writes the results via
 * lib/db.mjs's updateEligibilityFields + replaceJobLocations, stamping
 * jobs.eligibility_extraction_version.
 *
 * Resumable and idempotent: by default only processes jobs whose
 * eligibility_extraction_version isn't already the current combined
 * extractor version (see ELIGIBILITY_EXTRACTION_VERSION in
 * scanner/worker.mjs — this script computes the same string the same way),
 * so bumping ANY of the underlying extractor versions makes every job
 * eligible for reprocessing again on the next run. --force reprocesses
 * everything regardless.
 *
 * Retry-safe: each batch's DB work is wrapped with retry-with-backoff
 * (the recurring failure mode on this project's RDS instance is
 * autovacuum/scanner I/O contention causing transient statement timeouts,
 * not a bug in this script — same pattern as backfill-seniority.mjs and
 * backfill-skills.mjs). Logs which stage failed on each retry rather than
 * swallowing it.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-eligibility.mjs
 *   node --env-file=.env.local scripts/backfill-eligibility.mjs --force
 *   ELIGIBILITY_BATCH=100 node --env-file=.env.local scripts/backfill-eligibility.mjs
 *   ELIGIBILITY_START_ID=12345 node --env-file=.env.local scripts/backfill-eligibility.mjs
 */
import { query, closePool, updateEligibilityFields, replaceJobLocations, upsertJobClassifications } from '../lib/db.mjs';
import { classifyExperience, EXPERIENCE_EXTRACTOR_VERSION } from '../lib/experience.mjs';
import { classifyEducation, EDUCATION_EXTRACTOR_VERSION } from '../lib/education.mjs';
import { classifySponsorship, classifyCitizenship, classifyClearance, SPONSORSHIP_EXTRACTOR_VERSION, CITIZENSHIP_EXTRACTOR_VERSION, CLEARANCE_EXTRACTOR_VERSION } from '../lib/work-eligibility.mjs';
import { parseSalary, annualizeSalary, SALARY_EXTRACTOR_VERSION } from '../lib/salary-extract.mjs';
import { parseLocations, LOCATION_EXTRACTOR_VERSION } from '../lib/location.mjs';

const ELIGIBILITY_EXTRACTION_VERSION = [
  EXPERIENCE_EXTRACTOR_VERSION, EDUCATION_EXTRACTOR_VERSION, SPONSORSHIP_EXTRACTOR_VERSION,
  CITIZENSHIP_EXTRACTOR_VERSION, CLEARANCE_EXTRACTOR_VERSION, SALARY_EXTRACTOR_VERSION, LOCATION_EXTRACTOR_VERSION,
].join('+');

const FORCE = process.argv.includes('--force');
const BATCH = Number(process.env.ELIGIBILITY_BATCH || 150);
const INTER_BATCH_PAUSE_MS = 150;
const MAX_BATCH_RETRIES = 8;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_BATCH_RETRIES) throw err;
      const backoffMs = Math.min(30000, 1000 * 2 ** attempt);
      console.error(`  ⚠ ${label} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}): ${err.message} — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

async function main() {
  console.error(`Eligibility backfill starting. extractor version=${ELIGIBILITY_EXTRACTION_VERSION} force=${FORCE} batch=${BATCH}`);
  let lastId = Number(process.env.ELIGIBILITY_START_ID || 0);
  let processed = 0;
  const counts = { experience: 0, education: 0, sponsorship: 0, citizenship: 0, clearance: 0, salary: 0, location: 0 };
  const started = Date.now();

  while (true) {
    const { rows } = await withRetry(() => query(
      FORCE
        ? `SELECT id, title, location, description_clean FROM jobs WHERE id > $1 ORDER BY id LIMIT $2`
        : `SELECT id, title, location, description_clean FROM jobs
            WHERE id > $1 AND eligibility_extraction_version IS DISTINCT FROM $3
            ORDER BY id LIMIT $2`,
      FORCE ? [lastId, BATCH] : [lastId, BATCH, ELIGIBILITY_EXTRACTION_VERSION]
    ), 'select batch');
    if (!rows.length) break;

    const items = rows.map(row => {
      const desc = row.description_clean || '';
      const experience = classifyExperience(desc, row.title || '');
      const education = classifyEducation(desc);
      const sponsorship = classifySponsorship(desc);
      const citizenship = classifyCitizenship(desc);
      const clearance = classifyClearance(desc);
      const salary = parseSalary(desc);
      const salaryAnnual = annualizeSalary(salary.min, salary.max, salary.period);
      const locations = parseLocations(row.location || '');
      return { jobId: row.id, experience, education, sponsorship, citizenship, clearance, salary, salaryAnnual, locations };
    });

    await withRetry(() => updateEligibilityFields(items.map(item => ({
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
    }))), 'updateEligibilityFields');

    await withRetry(() => replaceJobLocations(items.flatMap(item => item.locations.map((loc, index) => ({
      jobId: item.jobId,
      city: loc.city,
      stateCode: loc.stateCode,
      countryCode: loc.countryCode,
      isPrimary: index === 0,
      isRemoteRestriction: loc.isRemote,
      region: loc.region,
    })))), 'replaceJobLocations');

    await withRetry(() => upsertJobClassifications(items.flatMap(item => [
      { jobId: item.jobId, fieldName: 'experience', value: `${item.experience.min ?? ''}-${item.experience.max ?? ''}`, confidence: item.experience.confidence, version: item.experience.extractorVersion, evidence: item.experience.evidence },
      { jobId: item.jobId, fieldName: 'education_level', value: item.education.level, confidence: item.education.confidence, version: item.education.extractorVersion, evidence: item.education.evidence },
      { jobId: item.jobId, fieldName: 'sponsorship_status', value: item.sponsorship.status, confidence: item.sponsorship.confidence, version: item.sponsorship.extractorVersion, evidence: item.sponsorship.evidence },
      { jobId: item.jobId, fieldName: 'citizenship_requirement', value: item.citizenship.required, confidence: item.citizenship.confidence, version: item.citizenship.extractorVersion, evidence: item.citizenship.evidence },
      { jobId: item.jobId, fieldName: 'clearance_type', value: item.clearance.type, confidence: item.clearance.confidence, version: item.clearance.extractorVersion, evidence: item.clearance.evidence },
      { jobId: item.jobId, fieldName: 'salary', value: `${item.salary.min ?? ''}-${item.salary.max ?? ''} ${item.salary.period ?? ''}`.trim(), confidence: item.salary.confidence, version: item.salary.extractorVersion, evidence: item.salary.evidence },
    ])), 'upsertJobClassifications');

    await sleep(INTER_BATCH_PAUSE_MS);

    for (const item of items) {
      if (item.experience.min != null) counts.experience++;
      if (item.education.level !== 'UNKNOWN') counts.education++;
      if (item.sponsorship.status !== 'UNKNOWN') counts.sponsorship++;
      if (item.citizenship.required) counts.citizenship++;
      if (item.clearance.type !== 'NONE') counts.clearance++;
      if (item.salary.min != null) counts.salary++;
      if (item.locations.length > 0) counts.location++;
    }

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    if (processed % 5000 === 0 || rows.length < BATCH) {
      console.error(`  [${processed.toLocaleString()} processed]  exp=${counts.experience} edu=${counts.education} sponsor=${counts.sponsorship} citizenship=${counts.citizenship} clearance=${counts.clearance} salary=${counts.salary} location=${counts.location}  last_id=${lastId}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\nEligibility backfill complete in ${elapsed}s.`);
  console.error(`  Processed: ${processed.toLocaleString()} jobs`);
  console.error(`  With experience_min: ${counts.experience.toLocaleString()}`);
  console.error(`  With education level: ${counts.education.toLocaleString()}`);
  console.error(`  With sponsorship status known: ${counts.sponsorship.toLocaleString()}`);
  console.error(`  With citizenship requirement: ${counts.citizenship.toLocaleString()}`);
  console.error(`  With clearance requirement: ${counts.clearance.toLocaleString()}`);
  console.error(`  With salary: ${counts.salary.toLocaleString()}`);
  console.error(`  With >=1 location: ${counts.location.toLocaleString()}`);
}

main()
  .catch(error => { console.error('Eligibility backfill failed:', error.message); process.exitCode = 1; })
  .finally(() => closePool());
