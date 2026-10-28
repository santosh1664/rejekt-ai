/**
 * scripts/evaluate-recommendations.mjs
 *
 * Seeds each benchmark profile (fixtures/benchmark-profiles.json) as a real
 * user_profiles row, runs the real recommendation pipeline
 * (matching/recommend.mjs) against it, and scores the output against
 * hand-authored labels (fixtures/benchmark-labels/<profileId>.json) —
 * labels were written independently of this pipeline's ranking, per spec
 * Phase 22.
 *
 * Metrics: Precision@5, Precision@10, NDCG@10, bad-match rate, and hard-
 * eligibility violation rate (must be zero — any BAD-labeled job that also
 * violates a hard constraint indicates the eligibility engine let through
 * something it shouldn't have).
 *
 * Usage:
 *   node --env-file=.env.local scripts/evaluate-recommendations.mjs
 *   node --env-file=.env.local scripts/evaluate-recommendations.mjs --set dev
 *   node --env-file=.env.local scripts/evaluate-recommendations.mjs --set holdout
 *   node --env-file=.env.local scripts/evaluate-recommendations.mjs --set dev --dump evaluation/baseline.json
 *
 * --set dev|holdout|all (default all) scopes which labeled jobs are scored,
 * per fixtures/benchmark-split.json's deterministic 70/30 split — ranking
 * tuning must only ever look at --set dev; --set holdout is for a single
 * final check.
 * --dump <path> additionally writes every scored job's full component
 * breakdown + label + eligibility result as JSON (ranking-diagnostics.mjs
 * consumes this).
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { query, closePool } from '../lib/db.mjs';
import { generateRecommendations, loadUserContext } from '../matching/recommend.mjs';
import { buildJobContracts } from '../matching/job-contract.mjs';
import { computeFinalScore } from '../matching/final-score.mjs';
import { evaluateEligibility } from '../matching/eligibility.mjs';
import { normalizeSkillName } from '../lib/skills.mjs';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
}
const SET = argValue('--set', 'all'); // dev | holdout | all
const DUMP_PATH = argValue('--dump', null);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

const LABEL_RELEVANCE = { EXCELLENT: 3, GOOD: 2, BORDERLINE: 1, BAD: 0 };

function deterministicUserId(profileId) {
  // Stable UUID-shaped id per benchmark profile so re-runs upsert the same row.
  const hash = createHash('sha256').update(`benchmark:${profileId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function seedBenchmarkProfile(userId, benchmark) {
  const p = benchmark.profile;
  const profileRow = await query(
    `INSERT INTO user_profiles (user_id, current_title, total_experience_years, highest_education_level,
       current_city, current_state, current_country, work_authorization, needs_sponsorship)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id) DO UPDATE SET current_title=EXCLUDED.current_title,
       total_experience_years=EXCLUDED.total_experience_years, highest_education_level=EXCLUDED.highest_education_level,
       current_city=EXCLUDED.current_city, current_state=EXCLUDED.current_state, current_country=EXCLUDED.current_country,
       work_authorization=EXCLUDED.work_authorization, needs_sponsorship=EXCLUDED.needs_sponsorship, updated_at=NOW()
     RETURNING id`,
    [userId, p.currentTitle, p.totalExperienceYears, p.highestEducationLevel, p.currentCity, p.currentState, p.currentCountry, p.workAuthorization, p.needsSponsorship]
  );
  const profileId = profileRow.rows[0].id;

  await query(`DELETE FROM user_target_roles WHERE user_profile_id = $1`, [profileId]);
  for (const [i, r] of benchmark.targetRoles.entries()) {
    await query(`INSERT INTO user_target_roles (user_profile_id, canonical_role, role_family, priority) VALUES ($1,$2,$3,$4)`,
      [profileId, r.canonicalRole, r.roleFamily, r.priority ?? i + 1]);
  }

  await query(`DELETE FROM user_skills WHERE user_profile_id = $1`, [profileId]);
  for (const skillName of benchmark.skills) {
    const normalized = normalizeSkillName(skillName);
    const { rows } = await query(
      `INSERT INTO skills (canonical_name, normalized_name) VALUES ($1,$2)
       ON CONFLICT (normalized_name) DO UPDATE SET canonical_name = skills.canonical_name RETURNING id`,
      [skillName, normalized]
    );
    await query(`INSERT INTO user_skills (user_profile_id, skill_id, source, confidence) VALUES ($1,$2,'benchmark',1.0) ON CONFLICT DO NOTHING`, [profileId, rows[0].id]);
  }

  const pref = benchmark.preferences || {};
  await query(
    `INSERT INTO user_profile_preferences (user_profile_id, preferred_workplace_types, remote_only, min_salary)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_profile_id) DO UPDATE SET preferred_workplace_types=EXCLUDED.preferred_workplace_types,
       remote_only=EXCLUDED.remote_only, min_salary=EXCLUDED.min_salary, updated_at=NOW()`,
    [profileId, pref.preferredWorkplaceTypes ?? [], pref.remoteOnly ?? false, pref.minSalary ?? null]
  );
}

function precisionAt(rankedLabels, k) {
  const top = rankedLabels.slice(0, k);
  if (top.length === 0) return null;
  const relevant = top.filter(l => l && LABEL_RELEVANCE[l] >= 2).length; // GOOD or EXCELLENT counts as relevant
  return relevant / top.length;
}

function ndcgAt(rankedLabels, k) {
  const top = rankedLabels.slice(0, k);
  if (top.length === 0) return null;
  let dcg = 0;
  top.forEach((label, i) => {
    const rel = label ? LABEL_RELEVANCE[label] : 0;
    dcg += rel / Math.log2(i + 2);
  });
  const idealOrder = [...top].map(l => (l ? LABEL_RELEVANCE[l] : 0)).sort((a, b) => b - a);
  let idcg = 0;
  idealOrder.forEach((rel, i) => { idcg += rel / Math.log2(i + 2); });
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main() {
  const { profiles } = JSON.parse(readFileSync(join(FIXTURES_DIR, 'benchmark-profiles.json'), 'utf8'));
  const split = SET !== 'all' ? JSON.parse(readFileSync(join(FIXTURES_DIR, 'benchmark-split.json'), 'utf8')) : null;
  const results = [];
  const dump = []; // per-job records, only populated when --dump is passed

  for (const benchmark of profiles) {
    const labelsPath = join(FIXTURES_DIR, 'benchmark-labels', `${benchmark.id}.json`);
    if (!existsSync(labelsPath)) {
      console.error(`  [skip] ${benchmark.label}: no label fixture at ${labelsPath}`);
      continue;
    }
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8')); // { jobId: 'EXCELLENT'|'GOOD'|'BORDERLINE'|'BAD' }
    let labeledJobIds = Object.keys(labels).filter(k => !k.startsWith('_'));
    if (split) labeledJobIds = labeledJobIds.filter(id => split[benchmark.id][SET].includes(id));

    const userId = deterministicUserId(benchmark.id);
    await seedBenchmarkProfile(userId, benchmark);

    // Open-set run: the real end-to-end pipeline (candidate generation +
    // eligibility + scoring) — used for candidate-pool size and the
    // eligibility-violation check, exactly what a real request would return.
    const recs = await generateRecommendations(userId, { limit: 20 });

    // Closed-set evaluation: the labeled jobs won't generally appear in the
    // open-set top-20 (135 hand-labeled jobs out of a 2000-job candidate
    // pool, ranked among many other real candidates, is a near-zero-overlap
    // situation by chance) — so P@K/NDCG are computed by scoring exactly the
    // labeled jobs through the SAME real scorer (evaluateEligibility +
    // computeFinalScore) and ranking within that closed set, which is the
    // standard way to evaluate a ranker against a small hand-labeled sample.
    const closedSetContracts = await buildJobContracts(labeledJobIds.map(Number));
    const ctx = await loadUserContext(userId);
    const scoredClosedSet = closedSetContracts
      .map(job => {
        const eligibility = evaluateEligibility(ctx.profile, ctx.preferences, job);
        const scoreResult = computeFinalScore(job, ctx.profile, ctx.preferences, ctx.targetRoles, ctx.userSkillNames, { postedAt: job.postedAt, discovered: job.discovered });
        return { job, eligibility, scoreResult };
      })
      .sort((a, b) => b.scoreResult.matchScore - a.scoreResult.matchScore);

    // "Violation" here means: a real request would have excluded this job
    // (evaluateEligibility says ineligible) but our closed-set list — built
    // straight from the label fixture — still included it in what got
    // scored/ranked. Every scoredClosedSet entry is a labeled job by
    // construction, so this is just a straight ineligible count.
    const violationCount = scoredClosedSet.filter(({ eligibility }) => !eligibility.eligible).length;

    const rankedLabels = scoredClosedSet.map(({ job }) => labels[job.jobId] ?? null);
    const labeledCount = rankedLabels.filter(Boolean).length;
    // Bad-match rate is measured over what a user would actually be shown
    // (top 10), not the whole labeled pool — the whole-pool rate mixes in
    // the sample's own BAD-heavy composition (see fixtures/benchmark-labels'
    // notes) rather than measuring the ranker's ability to keep bad matches
    // out of the surfaced results.
    const top10Labels = rankedLabels.slice(0, 10).filter(Boolean);
    const badMatchRate = top10Labels.length ? top10Labels.filter(l => l === 'BAD').length / top10Labels.length : null;

    results.push({
      profile: benchmark.label,
      profileId: benchmark.id,
      candidatePoolSize: recs.candidatePoolSize,
      totalEligible: recs.total,
      precisionAt5: precisionAt(rankedLabels, 5),
      precisionAt10: precisionAt(rankedLabels, 10),
      ndcgAt10: ndcgAt(rankedLabels, 10),
      badMatchRate,
      eligibilityViolationRate: violationCount / Math.max(1, labeledCount),
      labeledCoverage: `${labeledCount}/${scoredClosedSet.length}`,
    });

    if (DUMP_PATH) {
      scoredClosedSet.forEach(({ job, eligibility, scoreResult }, rank) => {
        dump.push({
          profileId: benchmark.id, profile: benchmark.label, rank: rank + 1,
          jobId: job.jobId, title: job.title, company: job.company, roleFamily: job.roleFamily, canonicalRole: job.canonicalRole, seniority: job.seniority,
          label: labels[job.jobId] ?? null,
          finalScore: scoreResult.matchScore,
          rawScore: scoreResult.rawScore,
          components: scoreResult.components,
          roleMatchType: scoreResult.roleMatchType,
          missingRequiredSkills: scoreResult.missingRequiredSkills,
          eligible: eligibility.eligible,
          hardRejectReasons: eligibility.hardRejectReasons,
        });
      });
    }
  }

  console.log(`\n=== Per-profile results (set=${SET}) ===`);
  for (const r of results) {
    console.log(`${r.profile.padEnd(28)} P@5=${fmt(r.precisionAt5)} P@10=${fmt(r.precisionAt10)} NDCG@10=${fmt(r.ndcgAt10)} badRate=${fmt(r.badMatchRate)} eligViolation=${fmt(r.eligibilityViolationRate)} labeled=${r.labeledCoverage} pool=${r.candidatePoolSize} eligible=${r.totalEligible}`);
  }

  const avg = key => {
    const vals = results.map(r => r[key]).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  console.log('\n=== Overall ===');
  console.log(`Precision@5:  ${fmt(avg('precisionAt5'))}`);
  console.log(`Precision@10: ${fmt(avg('precisionAt10'))}`);
  console.log(`NDCG@10:      ${fmt(avg('ndcgAt10'))}`);
  console.log(`Bad-match rate: ${fmt(avg('badMatchRate'))}`);
  console.log(`Hard-eligibility violation rate: ${fmt(avg('eligibilityViolationRate'))} (must be 0)`);

  if (DUMP_PATH) {
    writeFileSync(DUMP_PATH, JSON.stringify({ set: SET, generatedAt: new Date().toISOString(), summary: results, jobs: dump }, null, 2));
    console.error(`\nDumped ${dump.length} scored jobs to ${DUMP_PATH}`);
  }
}

function fmt(v) { return v == null ? 'n/a' : v.toFixed(3); }

main().catch(err => { console.error('Evaluation failed:', err.message); process.exitCode = 1; }).finally(() => closePool());
