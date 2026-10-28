/**
 * scripts/build-benchmark-v2.1.mjs
 *
 * Builds fixtures/benchmark-v2.1/{profiles.json, labels/*.json, split.json}.
 *
 * v2.1 fixes benchmark-v2's one design flaw (docs/benchmark-v2-methodology.md
 * "Known limitation"): quality buckets A/B/C/D/E/F/G/I could accidentally
 * include jobs that violate the profile's OWN deliberately-added hard
 * constraints (salaryIsHardConstraint, preferredEmploymentTypes=FULL_TIME),
 * contaminating quality-ranking metrics with eligibility-engine behavior.
 * v2.1 pre-filters every quality-bucket candidate through the actual,
 * authoritative matching/eligibility.mjs::evaluateEligibility() — the same
 * function the real recommendation pipeline uses — and tops up any bucket
 * that falls short after filtering, so the quality set is 100% eligible by
 * construction. Bucket H stays deliberately, exclusively hard-ineligible.
 *
 * Sampling strategy (buckets A-I), roleFitTier/seniorityGapTier/
 * skillOverlapTier, and decideLabel() are unchanged from
 * scripts/build-benchmark-v2.mjs (spec Step 7: preserve the labeling
 * rubric) — this script only adds the eligibility pre-filter/top-up loop
 * around the existing per-bucket queries.
 *
 * Usage: node --env-file=.env.local scripts/build-benchmark-v2.1.mjs
 */
import { query, closePool } from '../lib/db.mjs';
import { roleAdjacency } from '../lib/role-taxonomy.mjs';
import { FAMILY_ADJACENCY } from '../matching/role-score.mjs';
import { buildJobContracts } from '../matching/job-contract.mjs';
import { evaluateEligibility } from '../matching/eligibility.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

// Reuse v2's profile definitions verbatim (spec Step 1: preserve v2; v2.1
// changes the JOB sets, not the profiles) — already carries the two
// deliberate hard constraints (salaryIsHardConstraint, FULL_TIME-only).
const PROFILES = JSON.parse(readFileSync('fixtures/benchmark-v2/profiles.json', 'utf8')).profiles;

const SENIORITY_ORDINAL = { INTERN: 0, ENTRY: 1, JUNIOR: 1, MID: 2, SENIOR: 3, LEAD: 3, STAFF: 4, PRINCIPAL: 5, MANAGER: 4, DIRECTOR: 5, EXECUTIVE: 6 };
function userSeniorityOrdinal(years) {
  if (years == null) return 2;
  if (years < 1) return 0.5;
  if (years < 3) return 1;
  if (years < 5) return 2;
  if (years < 8) return 3;
  if (years < 12) return 4;
  if (years < 18) return 5;
  return 6;
}

function roleFitTier(job, target) {
  if (job.canonical_role === target.canonicalRole && job.canonical_role !== job.role_family) return 'EXACT';
  if (job.role_family === target.roleFamily) {
    const adj = roleAdjacency(job.canonical_role, target.canonicalRole);
    if (adj != null && adj >= 0.75) return 'ADJACENT';
    return 'RELATED';
  }
  const famAdj = FAMILY_ADJACENCY[target.roleFamily]?.[job.role_family] ?? FAMILY_ADJACENCY[job.role_family]?.[target.roleFamily];
  if (famAdj != null) return 'CROSS_FAMILY';
  return 'UNRELATED';
}

function seniorityGapTier(userYears, jobSeniority) {
  const jobOrd = SENIORITY_ORDINAL[jobSeniority];
  if (jobOrd == null) return 'MATCH';
  const gap = Math.abs(jobOrd - userSeniorityOrdinal(userYears));
  if (gap <= 1) return 'MATCH';
  if (gap <= 2) return 'MODERATE';
  return 'SEVERE';
}

function skillOverlapTier(profileSkills, requiredSkillNames) {
  if (!requiredSkillNames.length) return 'STRONG';
  const set = new Set(profileSkills.map(s => s.toLowerCase()));
  const matched = requiredSkillNames.filter(s => set.has(s.toLowerCase())).length;
  const ratio = matched / requiredSkillNames.length;
  if (ratio >= 0.5) return 'STRONG';
  if (ratio > 0) return 'PARTIAL';
  return 'WEAK';
}

function decideLabel(roleFit, seniorityGap, skillOverlap) {
  const reasons = [];
  if (roleFit === 'UNRELATED') { reasons.push('Wrong profession / unrelated role family'); return { label: 'BAD', reasons }; }
  if (roleFit === 'CROSS_FAMILY' && skillOverlap === 'WEAK') { reasons.push('Different field, no real required-skill overlap'); return { label: 'BAD', reasons }; }
  if (seniorityGap === 'SEVERE' && roleFit !== 'EXACT') { reasons.push('Severe seniority mismatch'); reasons.push(`Role fit: ${roleFit}`); return { label: 'BAD', reasons }; }
  if (skillOverlap === 'WEAK' && (roleFit === 'RELATED' || roleFit === 'CROSS_FAMILY')) { reasons.push('Major required-skill gap'); reasons.push(`Role fit: ${roleFit}`); return { label: 'BAD', reasons }; }
  if (roleFit === 'EXACT' && seniorityGap === 'MATCH' && skillOverlap === 'STRONG') { reasons.push('Exact target role'); reasons.push('Seniority matches'); reasons.push('Strong required-skill fit'); return { label: 'EXCELLENT', reasons }; }
  if ((roleFit === 'EXACT' || roleFit === 'ADJACENT') && (seniorityGap === 'MATCH' || seniorityGap === 'MODERATE') && (skillOverlap === 'STRONG' || skillOverlap === 'PARTIAL')) {
    reasons.push(`Role fit: ${roleFit}`); reasons.push(`Seniority: ${seniorityGap}`); reasons.push(`Skill overlap: ${skillOverlap}`);
    return { label: 'GOOD', reasons };
  }
  if (roleFit === 'EXACT' && seniorityGap === 'SEVERE') { reasons.push('Exact role but severe seniority gap'); return { label: 'BORDERLINE', reasons }; }
  reasons.push(`Role fit: ${roleFit}`); reasons.push(`Seniority: ${seniorityGap}`); reasons.push(`Skill overlap: ${skillOverlap}`);
  return { label: 'BORDERLINE', reasons };
}

async function fetchRequiredSkills(jobIds) {
  if (jobIds.length === 0) return new Map();
  const { rows } = await query(
    `SELECT js.job_id, s.normalized_name FROM job_skills js JOIN skills s ON s.id = js.skill_id
      WHERE js.job_id = ANY($1::bigint[]) AND js.importance = 'REQUIRED'`, [jobIds]
  );
  const map = new Map();
  for (const r of rows) { if (!map.has(r.job_id)) map.set(r.job_id, []); map.get(r.job_id).push(r.normalized_name); }
  return map;
}

// Same bucket targets as v2 (sums to 36/profile). H is untouched by
// eligibility filtering (it's supposed to fail). A-G/I now need enough
// headroom to survive eligibility attrition — handled by fetchEligible's
// widening retry loop below, not by inflating these targets.
const BUCKET_TARGET = { A: 11, B: 4, C: 4, D: 4, E: 3, F: 2, G: 3, H: 2, I: 3 };
const QUALITY_BUCKETS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I'];

/**
 * Fetches up to `target` eligible rows for one bucket, widening the query
 * limit and re-querying (excluding already-seen ids) when eligibility
 * filtering leaves the bucket short — spec Step 9: "sample replacement jobs
 * from the same stratified bucket" rather than silently shrinking it.
 * `queryFn(limit)` returns `[sql, params]` with `limit` as the final param.
 */
async function fetchEligible(target, seenIds, profile, queryFn, maxAttempts = 5) {
  const picked = [];
  let fetchLimit = Math.max(target * 3, 12);
  for (let attempt = 0; attempt < maxAttempts && picked.length < target; attempt++) {
    const [sql, params] = queryFn(fetchLimit);
    const { rows } = await query(sql, params);
    const fresh = rows.filter(r => !seenIds.has(r.id));
    fresh.forEach(r => seenIds.add(r.id));
    if (fresh.length === 0) { fetchLimit *= 2; continue; }

    const contracts = await buildJobContracts(fresh.map(r => Number(r.id)));
    const contractById = new Map(contracts.map(c => [c.jobId, c]));
    for (const r of fresh) {
      if (picked.length >= target) break;
      const contract = contractById.get(String(r.id));
      if (!contract) continue;
      const elig = evaluateEligibility(profile.profile, profile.preferences, contract);
      if (elig.eligible) picked.push(r);
    }
    fetchLimit *= 2;
  }
  return picked;
}

async function sampleBuckets(profile, target) {
  const fam = target.roleFamily, canon = target.canonicalRole;
  const seenIds = new Set();
  const buckets = {};
  const cols = `id, title, role_family, canonical_role, seniority_level, min_exp_years, max_exp_years, salary_max_annual, employment_type, workplace_type`;

  // A. obvious target-role jobs
  if (profile.id === 'qa_automation') {
    buckets.A = await fetchEligible(BUCKET_TARGET.A, seenIds, profile, limit => [
      `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND (
         title ~* '\\y(qa automation engineer|sdet|software test engineer|test automation engineer|automation qa engineer|api test engineer|selenium engineer|playwright automation engineer)\\y'
       ) ORDER BY random() LIMIT $1`, [limit]]);
  } else {
    buckets.A = await fetchEligible(BUCKET_TARGET.A, seenIds, profile, limit => [
      `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND canonical_role=$1 ORDER BY random() LIMIT $2`, [canon, limit]]);
  }

  // B. adjacent-role jobs (same family, real ROLE_ADJACENCY-defined relation)
  buckets.B = await fetchEligible(BUCKET_TARGET.B, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 AND canonical_role IS NOT NULL AND canonical_role != $2
       AND canonical_role = ANY($3::text[])
     ORDER BY random() LIMIT $4`,
    [fam, canon, adjacentCanonicalRoles(canon), limit]]);

  // C. same-family but wrong-specialization jobs
  if (profile.id === 'qa_automation') {
    buckets.C = await fetchEligible(BUCKET_TARGET.C, seenIds, profile, limit => [
      `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND (
          title ~* '\\y(manufacturing quality engineer|electrical test engineer|systems test engineer|industrial automation engineer|validation engineer|hardware test engineer)\\y'
        ) ORDER BY random() LIMIT $1`, [limit]]);
  } else {
    buckets.C = await fetchEligible(BUCKET_TARGET.C, seenIds, profile, limit => [
      `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 AND canonical_role IS NOT NULL AND canonical_role NOT IN ($2, 'SOFTWARE_ENGINEER')
         AND NOT (canonical_role = ANY($3::text[]))
       ORDER BY random() LIMIT $4`,
      [fam, canon, adjacentCanonicalRoles(canon), limit]]);
  }

  // D. unrelated jobs with overlapping generic skills
  buckets.D = await fetchEligible(BUCKET_TARGET.D, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs j WHERE status='READY' AND active=TRUE AND role_family NOT IN ($1, 'OTHER')
        AND EXISTS (SELECT 1 FROM job_skills js JOIN skills s ON s.id=js.skill_id WHERE js.job_id=j.id AND s.normalized_name = ANY($2::text[]))
        ORDER BY random() LIMIT $3`, [fam, profile.skills, limit]]);

  // E. seniority mismatch jobs (same family/role, far seniority)
  const wantSenior = profile.profile.totalExperienceYears >= 6;
  const seniorityFilter = wantSenior ? "seniority_level IN ('ENTRY','JUNIOR')" : "seniority_level IN ('STAFF','PRINCIPAL','DIRECTOR','EXECUTIVE')";
  buckets.E = await fetchEligible(BUCKET_TARGET.E, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 AND ${seniorityFilter} ORDER BY random() LIMIT $2`, [fam, limit]]);

  // F. location/salary attractive but role-wrong
  buckets.F = await fetchEligible(BUCKET_TARGET.F, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family NOT IN ($1,'OTHER') AND workplace_type='REMOTE' AND salary_max_annual > 150000 ORDER BY random() LIMIT $2`, [fam, limit]]);

  // G. low-signal/ambiguous jobs
  buckets.G = await fetchEligible(BUCKET_TARGET.G, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND (role_family='OTHER' OR canonical_role IS NULL) AND title ~* '\\yengineer\\y' ORDER BY random() LIMIT $1`, [limit]]);

  // H. hard-ineligible jobs — deliberately NOT eligibility-filtered (spec
  // Step 4: these must stay hard-ineligible). Plain sampling, same as v2.
  const { rows: hSalary } = await query(
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 AND (salary_max_annual < $2 AND salary_max_annual IS NOT NULL) ORDER BY random() LIMIT $3`,
    [fam, profile.preferences.minSalary, Math.ceil(BUCKET_TARGET.H / 2)]);
  buckets.H = hSalary.filter(r => !seenIds.has(r.id));
  buckets.H.forEach(r => seenIds.add(r.id));
  const hRest = BUCKET_TARGET.H - buckets.H.length;
  if (hRest > 0) {
    const { rows } = await query(`SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 AND employment_type NOT IN ('FULL_TIME','UNKNOWN') AND employment_type IS NOT NULL ORDER BY random() LIMIT $2`, [fam, hRest]);
    const fresh = rows.filter(r => !seenIds.has(r.id));
    fresh.forEach(r => seenIds.add(r.id));
    buckets.H.push(...fresh);
  }

  // I. randomly sampled eligible jobs (broad, family-agnostic)
  buckets.I = await fetchEligible(BUCKET_TARGET.I, seenIds, profile, limit => [
    `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND (role_family=$1 OR random() < 0.3) ORDER BY random() LIMIT $2`, [fam, limit]]);

  // Top-up (spec Step 9: target 30+ eligible quality jobs, minimum 25) —
  // eligibility filtering can shrink a profile below the floor even after
  // each bucket's own widening retry; pad with more target-canonical-role
  // (bucket-A-style) jobs, since that pool is the deepest, filtered the
  // same way through evaluateEligibility.
  const qualityTotal = () => QUALITY_BUCKETS.reduce((n, b) => n + buckets[b].length, 0);
  if (qualityTotal() < 30) {
    const need = 30 - qualityTotal();
    const extra = await fetchEligible(need, seenIds, profile, limit => [
      `SELECT ${cols} FROM jobs WHERE status='READY' AND active=TRUE AND role_family=$1 ORDER BY random() LIMIT $2`, [fam, limit]], 6);
    buckets.A = [...buckets.A, ...extra];
  }

  return buckets;
}

// Bucket B/C partition on the SAME roleAdjacency>=0.55 threshold v2 used,
// precomputed here since fetchEligible's queryFn needs a static param
// array (jobId adjacency can't be evaluated in SQL).
function adjacentCanonicalRoles(targetCanon) {
  // Pulled from lib/role-taxonomy.mjs's adjacency table at call time via
  // roleAdjacency() below — see buildAdjacentSet, computed once per profile
  // in main() and passed through closures would be cleaner, but this stays
  // a simple synchronous cache keyed by target since profiles.json is tiny.
  return adjacentSetCache.get(targetCanon) ?? [];
}
const adjacentSetCache = new Map();

async function main() {
  mkdirSync('fixtures/benchmark-v2.1/labels', { recursive: true });
  const allProfilesOut = [];
  const distributionReport = [];
  const eligibilityAudit = [];

  for (const profile of PROFILES) {
    await query(`SELECT setseed($1)`, [(parseInt(createHash('sha256').update(`v2.1:${profile.id}`).digest('hex').slice(0, 8), 16) % 1000) / 1000]);
    const target = profile.targetRoles[0];

    // Precompute the adjacent-canonical-role set for bucket B/C's SQL
    // (same >=0.55 roleAdjacency threshold as v2), by scanning distinct
    // canonical roles present in this family.
    const { rows: familyCanonRows } = await query(`SELECT DISTINCT canonical_role FROM jobs WHERE role_family=$1 AND canonical_role IS NOT NULL`, [target.roleFamily]);
    const adjacent = familyCanonRows.map(r => r.canonical_role).filter(c => { const adj = roleAdjacency(c, target.canonicalRole); return adj != null && adj >= 0.55; });
    adjacentSetCache.set(target.canonicalRole, adjacent.length ? adjacent : ['__none__']);

    const buckets = await sampleBuckets(profile, target);

    const allSampled = Object.entries(buckets).flatMap(([bucket, rows]) => rows.map(r => ({ ...r, _bucket: bucket })));
    const jobIds = allSampled.map(r => r.id);
    const requiredSkillsMap = await fetchRequiredSkills(jobIds);

    const labels = {};
    const counts = { EXCELLENT: 0, GOOD: 0, BORDERLINE: 0, BAD: 0, HARD_INELIGIBLE: 0 };
    for (const job of allSampled) {
      if (job._bucket === 'H') {
        labels[job.id] = { label: 'HARD_INELIGIBLE', reasons: [job.salary_max_annual != null ? 'Salary below required minimum' : `Excluded employment type: ${job.employment_type}`], bucket: job._bucket, title: job.title, set: 'eligibility' };
        counts.HARD_INELIGIBLE++;
        continue;
      }
      const rf = roleFitTier(job, target);
      const sg = seniorityGapTier(profile.profile.totalExperienceYears, job.seniority_level);
      const required = requiredSkillsMap.get(job.id) || [];
      const so = skillOverlapTier(profile.skills, required);
      const { label, reasons } = decideLabel(rf, sg, so);
      labels[job.id] = { label, reasons, bucket: job._bucket, title: job.title, roleFitTier: rf, seniorityGapTier: sg, skillOverlapTier: so, set: 'quality' };
      counts[label]++;
    }

    // Verification pass (spec Step 5's qualitySetEligibilityPassRate,
    // computed at build time too so a build-vs-eval mismatch would surface
    // immediately rather than only at evaluation time): every quality-set
    // job must be eligible; every eligibility-set (H) job must not be.
    const qualityIds = allSampled.filter(j => j._bucket !== 'H').map(j => j.id);
    const qualityContracts = await buildJobContracts(qualityIds.map(Number));
    const qualityEligible = qualityContracts.filter(c => evaluateEligibility(profile.profile, profile.preferences, c).eligible).length;
    const hIds = allSampled.filter(j => j._bucket === 'H').map(j => j.id);
    const hContracts = await buildJobContracts(hIds.map(Number));
    const hRejected = hContracts.filter(c => !evaluateEligibility(profile.profile, profile.preferences, c).eligible).length;

    writeFileSync(`fixtures/benchmark-v2.1/labels/${profile.id}.json`, JSON.stringify(labels, null, 2) + '\n');
    allProfilesOut.push(profile);
    distributionReport.push({ profileId: profile.id, qualityTotal: qualityIds.length, ...counts, qualityEligiblePassRate: qualityIds.length ? (qualityEligible / qualityIds.length).toFixed(3) : 'n/a' });
    eligibilityAudit.push({ profileId: profile.id, qualityTotal: qualityIds.length, qualityEligible, hardIneligibleTotal: hIds.length, hardIneligibleRejected: hRejected });
    console.log(`${profile.label.padEnd(24)} quality=${qualityIds.length} (eligiblePass=${qualityEligible}/${qualityIds.length})  EXCELLENT=${counts.EXCELLENT} GOOD=${counts.GOOD} BORDERLINE=${counts.BORDERLINE} BAD=${counts.BAD}  H=${hIds.length} (rejected=${hRejected}/${hIds.length})`);
  }

  writeFileSync('fixtures/benchmark-v2.1/profiles.json', JSON.stringify({ profiles: allProfilesOut }, null, 2) + '\n');

  // Same deterministic ~70/30 dev/holdout split methodology as v2 (full
  // sorted job-id list per profile, every 3rd id -> holdout) — spec Step 10.
  const split = {};
  for (const profile of allProfilesOut) {
    const labels = JSON.parse(readFileSync(`fixtures/benchmark-v2.1/labels/${profile.id}.json`, 'utf8'));
    const sorted = Object.keys(labels).sort();
    const dev = [], holdout = [];
    sorted.forEach((id, i) => { (i % 3 === 2 ? holdout : dev).push(id); });
    split[profile.id] = { dev, holdout };
  }
  writeFileSync('fixtures/benchmark-v2.1/split.json', JSON.stringify(split, null, 2) + '\n');

  console.log('\n=== Label distribution (v2.1) ===');
  console.table(distributionReport);
  console.log('\n=== Eligibility construction audit ===');
  console.table(eligibilityAudit);
  await closePool();
}

main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
