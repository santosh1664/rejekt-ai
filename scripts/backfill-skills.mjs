/**
 * scripts/backfill-skills.mjs
 *
 * (Re)extracts skills for existing jobs using the current taxonomy
 * (data/skills-taxonomy.json via lib/skill-extract.mjs) and writes
 * job_skills, stamping jobs.extraction_version with the taxonomy version.
 *
 * Resumable and idempotent: by default only processes jobs whose
 * extraction_version isn't already the current taxonomy version, so
 * re-running after an interruption picks up where it left off, and bumping
 * the taxonomy's "version" field in data/skills-taxonomy.json makes every
 * job eligible for reprocessing again on the next run — no --force needed
 * for an ordinary taxonomy update. --force reprocesses everything
 * regardless of extraction_version (e.g. to pick up a matching-logic change
 * that didn't bump the taxonomy version).
 *
 * lib/db.mjs's upsertExtractedSkills recomputes each job's full skill set
 * from scratch and deletes any job_skills rows for that job the current
 * extraction did not reproduce — so a false positive fixed in the taxonomy
 * is cleaned up automatically, not just added to.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-skills.mjs
 *   node --env-file=.env.local scripts/backfill-skills.mjs --force
 *   SKILLS_BATCH=100 node --env-file=.env.local scripts/backfill-skills.mjs
 *   SKILLS_START_ID=12345 node --env-file=.env.local scripts/backfill-skills.mjs
 */
import { query, closePool, upsertExtractedSkills } from '../lib/db.mjs';
import { extractSkills, skillExtractorVersion } from '../lib/skill-extract.mjs';

const FORCE = process.argv.includes('--force');
const BATCH = Number(process.env.SKILLS_BATCH || 150);
const INTER_BATCH_PAUSE_MS = 150;
const MAX_BATCH_RETRIES = 8;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Batches are idempotent for a given lastId (SELECT re-reads the same
// not-yet-processed window; upsertExtractedSkills recomputes each job's
// full skill set from scratch), so on a transient timeout — autovacuum or
// scanner I/O contention, the recurring failure mode on this RDS instance —
// retry with backoff instead of crashing the whole run.
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
  console.error(`Skill backfill starting. extractor version=${skillExtractorVersion} force=${FORCE} batch=${BATCH}`);
  let lastId = Number(process.env.SKILLS_START_ID || 0);
  let processed = 0;
  let jobsWithSkills = 0;
  let totalSkillMatches = 0;
  const started = Date.now();

  while (true) {
    const { rows } = await withRetry(() => query(
      FORCE
        ? `SELECT id, description_clean FROM jobs WHERE id > $1 ORDER BY id LIMIT $2`
        : `SELECT id, description_clean FROM jobs
            WHERE id > $1 AND extraction_version IS DISTINCT FROM $3
            ORDER BY id LIMIT $2`,
      FORCE ? [lastId, BATCH] : [lastId, BATCH, skillExtractorVersion]
    ), 'select batch');
    if (!rows.length) break;

    const items = rows.map(row => ({
      jobId: row.id,
      skills: extractSkills(row.description_clean || ''),
    }));

    await withRetry(() => upsertExtractedSkills(items), 'upsert batch');
    await sleep(INTER_BATCH_PAUSE_MS);

    for (const item of items) {
      if (item.skills.length > 0) jobsWithSkills++;
      totalSkillMatches += item.skills.length;
    }

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    if (processed % 5000 === 0 || rows.length < BATCH) {
      console.error(`  [${processed.toLocaleString()} processed]  with_skills=${jobsWithSkills.toLocaleString()}  last_id=${lastId}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\nSkill backfill complete in ${elapsed}s.`);
  console.error(`  Processed:        ${processed.toLocaleString()} jobs`);
  console.error(`  With >=1 skill:   ${jobsWithSkills.toLocaleString()}`);
  console.error(`  Total skill rows: ${totalSkillMatches.toLocaleString()}`);
}

main()
  .catch(error => { console.error('Skill backfill failed:', error.message); process.exitCode = 1; })
  .finally(() => closePool());
