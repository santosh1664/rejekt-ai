/**
 * matching/matcher.mjs
 *
 * Scores jobs 0–100 against each active user_preference row and
 * writes matches to user_job_alerts. Designed to run after every
 * scan cycle (orchestrator calls it automatically).
 *
 * Scoring breakdown (100 pts):
 *   +40  title keyword match (any keyword in title, case-insensitive)
 *   +25  category match
 *   +20  location match  (or remote_only satisfied)
 *   +15  remote flag match
 *   ─ 99  excluded company  → score 0, skip insert
 *
 * Usage (standalone):
 *   node --env-file=.env.local matching/matcher.mjs [--verbose] [--dry-run]
 */

import { query, closePool } from '../lib/db.mjs';

// ─── Score a single job against a single preference ──────────────────────────

export function scoreJob(job, pref) {
  // Hard exclusions
  if (pref.exclude_companies?.length) {
    const compLower = (job.company ?? '').toLowerCase();
    const excluded  = pref.exclude_companies.some(
      (ec) => compLower.includes(ec.toLowerCase())
    );
    if (excluded) return 0;
  }

  let score = 0;

  // +40 — title keyword match
  if (pref.title_keywords?.length) {
    const titleLower = (job.title ?? '').toLowerCase();
    const hit = pref.title_keywords.some((kw) =>
      titleLower.includes(kw.toLowerCase())
    );
    if (hit) score += 40;
  } else {
    score += 40;
  }

  // +25 — category match
  if (pref.categories?.length) {
    if (pref.categories.includes(job.category)) score += 25;
  } else {
    score += 25;
  }

  // +20 — location match
  if (pref.remote_only) {
    if (job.remote) score += 20;
  } else if (pref.locations?.length) {
    const locLower = (job.location ?? '').toLowerCase();
    const hit = pref.locations.some((loc) =>
      locLower.includes(loc.toLowerCase())
    );
    if (hit || job.remote) score += 20;
  } else {
    score += 20;
  }

  // +15 — remote bonus
  if (!pref.remote_only) {
    score += 15;  // non-remote_only: everyone gets the 15pts equally
  }

  return Math.min(score, 100);
}

// ─── Batch: match new jobs to all active preferences ─────────────────────────

export async function matchNewJobs(opts = {}) {
  const since   = opts.since ?? 360;
  const dryRun  = opts.dryRun ?? false;
  const verbose = opts.verbose ?? false;

  const { rows: prefs } = await query(`
    SELECT id, user_id, title_keywords, locations, remote_only,
           categories, exclude_companies, min_match_score
      FROM user_preferences
     WHERE active = TRUE
  `);

  if (prefs.length === 0) {
    if (verbose) console.error('  matcher: no active preferences');
    return { matched: 0, skipped: 0, errors: 0 };
  }

  let jobs;
  if (opts.jobIds?.length) {
    const { rows } = await query(
      `SELECT id, title, company, location, remote, ats, category
         FROM jobs WHERE id = ANY($1) AND active = TRUE`,
      [opts.jobIds]
    );
    jobs = rows;
  } else {
    const { rows } = await query(
      `SELECT id, title, company, location, remote, ats, category
         FROM jobs
        WHERE active = TRUE
          AND discovered > NOW() - ($1 * interval '1 minute')
        ORDER BY discovered DESC`,
      [since]
    );
    jobs = rows;
  }

  if (verbose) {
    console.error(`  matcher: ${jobs.length} candidate jobs × ${prefs.length} preferences`);
  }

  if (jobs.length === 0) return { matched: 0, skipped: 0, errors: 0 };

  let matched = 0;
  let skipped = 0;
  let errors  = 0;

  for (const pref of prefs) {
    const alerts = [];

    for (const job of jobs) {
      const score = scoreJob(job, pref);
      if (score < (pref.min_match_score ?? 50)) { skipped++; continue; }
      alerts.push({ job_id: job.id, pref_id: pref.id, user_id: pref.user_id, score });
      matched++;
    }

    if (alerts.length === 0 || dryRun) continue;

    try {
      const rows   = alerts.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`);
      const params = alerts.flatMap((a) => [a.user_id, a.job_id, a.pref_id, a.score]);
      await query(
        `INSERT INTO user_job_alerts (user_id, job_id, pref_id, score)
         VALUES ${rows.join(', ')}
         ON CONFLICT (user_id, job_id) DO UPDATE
           SET score = GREATEST(user_job_alerts.score, EXCLUDED.score)`,
        params
      );
    } catch (err) {
      console.error(`  matcher: alert upsert error for user ${pref.user_id}: ${err.message}`);
      errors++;
    }
  }

  return { matched, skipped, errors };
}

// ─── Re-run matching for one user against the full active job corpus ──────────

export async function matchUserFull(userId, opts = {}) {
  const dryRun  = opts.dryRun ?? false;
  const verbose = opts.verbose ?? false;

  const { rows: prefs } = await query(
    `SELECT id, user_id, title_keywords, locations, remote_only,
            categories, exclude_companies, min_match_score
       FROM user_preferences
      WHERE user_id = $1 AND active = TRUE`,
    [userId]
  );

  if (prefs.length === 0) return { matched: 0, skipped: 0 };

  const { rows: jobs } = await query(`
    SELECT id, title, company, location, remote, ats, category
      FROM jobs WHERE active = TRUE
     ORDER BY discovered DESC LIMIT 100000
  `);

  if (verbose) console.error(`  matchUserFull: ${jobs.length} jobs × ${prefs.length} prefs`);

  let matched = 0;
  let skipped = 0;

  for (const pref of prefs) {
    const alerts = [];
    for (const job of jobs) {
      const score = scoreJob(job, pref);
      if (score < (pref.min_match_score ?? 50)) { skipped++; continue; }
      alerts.push({ job_id: job.id, pref_id: pref.id, user_id: pref.user_id, score });
      matched++;
    }

    if (alerts.length === 0 || dryRun) continue;

    const rows   = alerts.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`);
    const params = alerts.flatMap((a) => [a.user_id, a.job_id, a.pref_id, a.score]);

    await query(
      `INSERT INTO user_job_alerts (user_id, job_id, pref_id, score)
       VALUES ${rows.join(', ')}
       ON CONFLICT (user_id, job_id) DO UPDATE
         SET score = GREATEST(user_job_alerts.score, EXCLUDED.score)`,
      params
    );
  }

  return { matched, skipped };
}

// ─── CLI standalone ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('matcher.mjs')) {
  const verbose = process.argv.includes('--verbose');
  const dryRun  = process.argv.includes('--dry-run');

  matchNewJobs({ verbose, dryRun })
    .then(({ matched, skipped, errors }) => {
      console.error(`Matched : ${matched}`);
      console.error(`Skipped : ${skipped}`);
      console.error(`Errors  : ${errors}`);
      if (dryRun) console.error('[DRY RUN — nothing written]');
    })
    .catch((err) => { console.error('Fatal:', err.message); process.exit(1); })
    .finally(() => closePool());
}
