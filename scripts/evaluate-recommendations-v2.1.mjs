/**
 * scripts/evaluate-recommendations-v2.1.mjs
 *
 * Evaluates the ranking pipeline against benchmark-v2.1
 * (fixtures/benchmark-v2.1/) — same metrics machinery as
 * evaluate-recommendations-v2.mjs, but the eligibility reporting is
 * corrected (spec Step 5): benchmark-v2's "eligibility violation rate" on
 * the quality set was misleading because quality buckets could legitimately
 * contain jobs that violate the profile's OWN hard constraints (v2.1's
 * quality set is pre-filtered through evaluateEligibility() at build time,
 * so any violation found here would be a genuine build/eval inconsistency,
 * not expected noise). Reports:
 *   - qualitySetEligibilityPassRate (expect 1.0)
 *   - hard-ineligible rejection accuracy (bucket H, expect 1.0)
 *   - falseAcceptRate  = bucket-H jobs the engine wrongly calls eligible
 *   - falseRejectRate  = quality-set jobs the engine wrongly calls ineligible
 *
 * Usage:
 *   node --env-file=.env.local scripts/evaluate-recommendations-v2.1.mjs --set dev
 *   node --env-file=.env.local scripts/evaluate-recommendations-v2.1.mjs --set holdout --dump evaluation/benchmark-v2.1-baseline.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { query, closePool } from '../lib/db.mjs';
import { generateRecommendations, loadUserContext } from '../matching/recommend.mjs';
import { buildJobContracts } from '../matching/job-contract.mjs';
import { computeFinalScore } from '../matching/final-score.mjs';
import { evaluateEligibility } from '../matching/eligibility.mjs';
import { normalizeSkillName } from '../lib/skills.mjs';

const args = process.argv.slice(2);
function argValue(flag, fallback) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : fallback; }
const SET = argValue('--set', 'all');
const DUMP_PATH = argValue('--dump', null);

const FIXTURES_DIR = 'fixtures/benchmark-v2.1';
const LABEL_RELEVANCE = { EXCELLENT: 3, GOOD: 2, BORDERLINE: 1, BAD: 0 };
const RELEVANT_LABELS = new Set(['GOOD', 'EXCELLENT']);

function deterministicUserId(profileId) {
  const hash = createHash('sha256').update(`benchmark-v2.1:${profileId}`).digest('hex');
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
    `INSERT INTO user_profile_preferences (user_profile_id, preferred_workplace_types, remote_only, min_salary, salary_is_hard_constraint, preferred_employment_types)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_profile_id) DO UPDATE SET preferred_workplace_types=EXCLUDED.preferred_workplace_types,
       remote_only=EXCLUDED.remote_only, min_salary=EXCLUDED.min_salary, salary_is_hard_constraint=EXCLUDED.salary_is_hard_constraint,
       preferred_employment_types=EXCLUDED.preferred_employment_types, updated_at=NOW()`,
    [profileId, pref.preferredWorkplaceTypes ?? [], pref.remoteOnly ?? false, pref.minSalary ?? null, pref.salaryIsHardConstraint ?? false, pref.preferredEmploymentTypes ?? []]
  );
}

function precisionAt(rankedLabels, k) {
  const top = rankedLabels.slice(0, k);
  if (top.length === 0) return null;
  const relevant = top.filter(l => l && RELEVANT_LABELS.has(l)).length;
  return relevant / top.length;
}
function recallAt(rankedLabels, k, totalRelevant) {
  if (totalRelevant === 0) return null;
  const top = rankedLabels.slice(0, k);
  const relevant = top.filter(l => l && RELEVANT_LABELS.has(l)).length;
  return relevant / totalRelevant;
}
function ndcgAt(rankedLabels, k) {
  const top = rankedLabels.slice(0, k);
  if (top.length === 0) return null;
  let dcg = 0;
  top.forEach((label, i) => { dcg += (label ? LABEL_RELEVANCE[label] : 0) / Math.log2(i + 2); });
  const idealOrder = [...top].map(l => (l ? LABEL_RELEVANCE[l] : 0)).sort((a, b) => b - a);
  let idcg = 0;
  idealOrder.forEach((rel, i) => { idcg += rel / Math.log2(i + 2); });
  return idcg === 0 ? 0 : dcg / idcg;
}
function mrr(rankedLabels) {
  const idx = rankedLabels.findIndex(l => l && RELEVANT_LABELS.has(l));
  return idx === -1 ? 0 : 1 / (idx + 1);
}
function maxPrecisionAt(totalRelevant, k) { return Math.min(totalRelevant, k) / k; }
function normalizedPrecisionAt(rankedLabels, k, totalRelevant) {
  if (totalRelevant === 0) return null;
  const top = rankedLabels.slice(0, k);
  const relevant = top.filter(l => l && RELEVANT_LABELS.has(l)).length;
  return relevant / Math.min(k, totalRelevant);
}
function badMatchAt(rankedLabels, k) {
  const top = rankedLabels.slice(0, k).filter(Boolean);
  return top.length ? top.filter(l => l === 'BAD').length / top.length : null;
}

async function main() {
  const { profiles } = JSON.parse(readFileSync(`${FIXTURES_DIR}/profiles.json`, 'utf8'));
  const split = SET !== 'all' ? JSON.parse(readFileSync(`${FIXTURES_DIR}/split.json`, 'utf8')) : null;
  const results = [];
  const dump = [];

  for (const benchmark of profiles) {
    const labelsPath = `${FIXTURES_DIR}/labels/${benchmark.id}.json`;
    const rawLabels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    let jobIds = Object.keys(rawLabels);
    if (split) jobIds = jobIds.filter(id => split[benchmark.id][SET].includes(id));

    const qualityJobIds = jobIds.filter(id => rawLabels[id].set === 'quality');
    const hardIneligibleIds = jobIds.filter(id => rawLabels[id].set === 'eligibility');

    const userId = deterministicUserId(benchmark.id);
    await seedBenchmarkProfile(userId, benchmark);

    const recs = await generateRecommendations(userId, { limit: 20 });

    // Candidate recall (spec Step 13): are GOOD/EXCELLENT labeled jobs even
    // reachable by the real, open-set candidate query?
    const relevantIds = qualityJobIds.filter(id => RELEVANT_LABELS.has(rawLabels[id].label));
    let candidateRecall = null;
    if (relevantIds.length > 0) {
      const { rows: poolRows } = await query(
        `SELECT j.id FROM jobs j WHERE j.id = ANY($1::bigint[]) AND j.status='READY' AND j.active=TRUE`,
        [relevantIds.map(Number)]
      );
      candidateRecall = { relevant: relevantIds.length, stillActive: poolRows.length };
    }

    const closedSetContracts = await buildJobContracts(qualityJobIds.map(Number));
    const ctx = await loadUserContext(userId);
    const scoredClosedSet = closedSetContracts
      .map(job => {
        const eligibility = evaluateEligibility(ctx.profile, ctx.preferences, job);
        const scoreResult = computeFinalScore(job, ctx.profile, ctx.preferences, ctx.targetRoles, ctx.userSkillNames, { postedAt: job.postedAt, discovered: job.discovered });
        return { job, eligibility, scoreResult };
      })
      .sort((a, b) => b.scoreResult.matchScore - a.scoreResult.matchScore);

    // False rejects: quality-set jobs (pre-filtered eligible at build time)
    // that the engine now calls ineligible. Expected 0 — any non-zero count
    // is a genuine build-vs-eval inconsistency (e.g. profile seeding drift),
    // not expected benchmark noise (spec Step 5).
    const falseRejects = scoredClosedSet.filter(({ eligibility }) => !eligibility.eligible).length;
    const rankedLabels = scoredClosedSet.map(({ job }) => rawLabels[job.jobId]?.label ?? null);
    const totalRelevant = rankedLabels.filter(l => l && RELEVANT_LABELS.has(l)).length;

    // False accepts: bucket-H jobs (deliberately hard-ineligible) the engine
    // wrongly calls eligible. This is the real engine-correctness check.
    const hardIneligibleContracts = await buildJobContracts(hardIneligibleIds.map(Number));
    let falseAccepts = 0;
    for (const job of hardIneligibleContracts) {
      const elig = evaluateEligibility(ctx.profile, ctx.preferences, job);
      if (elig.eligible) falseAccepts++;
    }

    results.push({
      profile: benchmark.label, profileId: benchmark.id,
      candidatePoolSize: recs.candidatePoolSize, totalEligible: recs.total,
      precisionAt5: precisionAt(rankedLabels, 5), precisionAt10: precisionAt(rankedLabels, 10),
      maxPrecisionAt5: maxPrecisionAt(totalRelevant, 5), maxPrecisionAt10: maxPrecisionAt(totalRelevant, 10),
      normalizedPrecisionAt5: normalizedPrecisionAt(rankedLabels, 5, totalRelevant), normalizedPrecisionAt10: normalizedPrecisionAt(rankedLabels, 10, totalRelevant),
      recallAt10: recallAt(rankedLabels, 10, totalRelevant),
      ndcgAt5: ndcgAt(rankedLabels, 5), ndcgAt10: ndcgAt(rankedLabels, 10),
      mrr: mrr(rankedLabels),
      badMatchAt5: badMatchAt(rankedLabels, 5), badMatchAt10: badMatchAt(rankedLabels, 10),
      qualitySetEligibilityPassRate: qualityJobIds.length ? 1 - falseRejects / qualityJobIds.length : null,
      falseRejects, qualitySetTotal: qualityJobIds.length,
      falseAccepts, hardIneligibleTotal: hardIneligibleIds.length,
      candidateRecall,
      totalRelevant,
    });

    if (DUMP_PATH) {
      scoredClosedSet.forEach(({ job, eligibility, scoreResult }, rank) => {
        dump.push({
          profileId: benchmark.id, profile: benchmark.label, rank: rank + 1,
          jobId: job.jobId, title: job.title, roleFamily: job.roleFamily, canonicalRole: job.canonicalRole,
          label: rawLabels[job.jobId]?.label ?? null, labelReasons: rawLabels[job.jobId]?.reasons ?? [],
          finalScore: scoreResult.matchScore, rawScore: scoreResult.rawScore,
          components: scoreResult.components, roleMatchType: scoreResult.roleMatchType,
          missingRequiredSkills: scoreResult.missingRequiredSkills,
          eligible: eligibility.eligible,
        });
      });
    }
  }

  console.log(`\n=== Per-profile results (benchmark-v2.1, set=${SET}) ===`);
  for (const r of results) {
    console.log(`${r.profile.padEnd(24)} P@5=${fmt(r.precisionAt5)}(max ${fmt(r.maxPrecisionAt5)}, norm ${fmt(r.normalizedPrecisionAt5)}) P@10=${fmt(r.precisionAt10)}(max ${fmt(r.maxPrecisionAt10)}, norm ${fmt(r.normalizedPrecisionAt10)}) R@10=${fmt(r.recallAt10)} NDCG@5=${fmt(r.ndcgAt5)} NDCG@10=${fmt(r.ndcgAt10)} MRR=${fmt(r.mrr)} bad@5=${fmt(r.badMatchAt5)} bad@10=${fmt(r.badMatchAt10)} qualPassRate=${fmt(r.qualitySetEligibilityPassRate)} hardIneligAcc=${r.hardIneligibleTotal - r.falseAccepts}/${r.hardIneligibleTotal} totalRel=${r.totalRelevant} qualN=${r.qualitySetTotal}`);
  }

  const avg = key => { const vals = results.map(r => r[key]).filter(v => v != null); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; };
  console.log('\n=== Overall ===');
  console.log(`Precision@5:  ${fmt(avg('precisionAt5'))}  (max ${fmt(avg('maxPrecisionAt5'))}, normalized ${fmt(avg('normalizedPrecisionAt5'))})`);
  console.log(`Precision@10: ${fmt(avg('precisionAt10'))}  (max ${fmt(avg('maxPrecisionAt10'))}, normalized ${fmt(avg('normalizedPrecisionAt10'))})`);
  console.log(`Recall@10:    ${fmt(avg('recallAt10'))}`);
  console.log(`NDCG@5:       ${fmt(avg('ndcgAt5'))}`);
  console.log(`NDCG@10:      ${fmt(avg('ndcgAt10'))}`);
  console.log(`MRR:          ${fmt(avg('mrr'))}`);
  console.log(`Bad-match@5:  ${fmt(avg('badMatchAt5'))}`);
  console.log(`Bad-match@10: ${fmt(avg('badMatchAt10'))}`);

  const totalQuality = results.reduce((s, r) => s + r.qualitySetTotal, 0);
  const totalFalseRejects = results.reduce((s, r) => s + r.falseRejects, 0);
  const totalHardIneligible = results.reduce((s, r) => s + r.hardIneligibleTotal, 0);
  const totalFalseAccepts = results.reduce((s, r) => s + r.falseAccepts, 0);
  console.log(`\nQuality-set eligibility pass rate: ${fmt(1 - totalFalseRejects / totalQuality)} (expect 1.000 — quality set is pre-filtered eligible at build time)`);
  console.log(`False reject rate (quality set):   ${fmt(totalFalseRejects / totalQuality)} (${totalFalseRejects}/${totalQuality})`);
  console.log(`Hard-ineligible rejection accuracy: ${fmt(1 - totalFalseAccepts / totalHardIneligible)} (${totalHardIneligible - totalFalseAccepts}/${totalHardIneligible} correctly rejected)`);
  console.log(`False accept rate (bucket H):       ${fmt(totalFalseAccepts / totalHardIneligible)} (${totalFalseAccepts}/${totalHardIneligible})`);

  if (DUMP_PATH) {
    writeFileSync(DUMP_PATH, JSON.stringify({ set: SET, generatedAt: new Date().toISOString(), summary: results, jobs: dump }, null, 2));
    console.error(`\nDumped ${dump.length} scored jobs to ${DUMP_PATH}`);
  }
}

function fmt(v) { return v == null ? 'n/a' : v.toFixed(3); }

main().catch(err => { console.error('Evaluation failed:', err.message, err.stack); process.exitCode = 1; }).finally(() => closePool());
