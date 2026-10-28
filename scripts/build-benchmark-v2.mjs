/**
 * scripts/build-benchmark-v2.mjs
 *
 * Builds fixtures/benchmark-v2/{profiles.json, labels/*.json, split.json}.
 *
 * Stratified sampling (spec Step 4) across 9 buckets per profile, using
 * ONLY structured job metadata (canonical_role, role_family, seniority_level,
 * min/max_exp_years, job_skills) to assign labels via a deterministic,
 * written rubric (spec Step 7) — NEVER matching/role-score.mjs or
 * matching/final-score.mjs's computed scores. This is what makes the
 * benchmark independent of the ranking model being evaluated against it.
 *
 * Usage: node --env-file=.env.local scripts/build-benchmark-v2.mjs
 */
import { query, closePool } from '../lib/db.mjs';
import { roleAdjacency } from '../lib/role-taxonomy.mjs';
import { FAMILY_ADJACENCY } from '../matching/role-score.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const OLD = JSON.parse(readFileSync('fixtures/benchmark-profiles.json', 'utf8')).profiles;

// v2 adds a real, testable hard-eligibility preference to each profile
// (spec Step 9) — salary-hard-constraint and full-time-only — without
// touching any ranking/eligibility logic itself, just setting preference
// flags the existing eligibility engine already supports.
const PROFILES = OLD.map(p => ({
  ...p,
  preferences: { ...p.preferences, salaryIsHardConstraint: true, preferredEmploymentTypes: ['FULL_TIME'] },
}));

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
  // A generic canonical role (e.g. SOFTWARE_ENGINEER) is excluded from
  // matching/role-score.mjs's own EXACT_CANONICAL tier because THAT check
  // compares two arbitrary jobs against each other (where two unrelated
  // jobs coincidentally both falling back to "generic software" shouldn't
  // count as a real match). Here we're comparing one job directly against
  // the profile's OWN declared target — if the target itself is generic
  // (e.g. an entry-level profile that just wants "Software Engineer" roles
  // broadly) and the job resolved to that same genuinely-software-titled
  // generic value (not a raw role_family fallback — Cookie Crew-style
  // non-matches already fail the next clause), that's a legitimate,
  // literal match on what the user asked for, not a coincidental collision.
  if (job.canonical_role === target.canonicalRole && job.canonical_role !== job.role_family) return 'EXACT';
  if (job.role_family === target.roleFamily) {
    const adj = roleAdjacency(job.canonical_role, target.canonicalRole);
    if (adj != null && adj >= 0.75) return 'ADJACENT';
    return 'RELATED'; // same family, no/weak adjacency (includes generic-canonical-role cases)
  }
  const famAdj = FAMILY_ADJACENCY[target.roleFamily]?.[job.role_family] ?? FAMILY_ADJACENCY[job.role_family]?.[target.roleFamily];
  if (famAdj != null) return 'CROSS_FAMILY';
  return 'UNRELATED';
}

function seniorityGapTier(userYears, jobSeniority) {
  const jobOrd = SENIORITY_ORDINAL[jobSeniority];
  if (jobOrd == null) return 'MATCH'; // unknown seniority -> don't penalize
  const gap = Math.abs(jobOrd - userSeniorityOrdinal(userYears));
  if (gap <= 1) return 'MATCH';
  if (gap <= 2) return 'MODERATE';
  return 'SEVERE';
}

function skillOverlapTier(profileSkills, requiredSkillNames) {
  if (!requiredSkillNames.length) return 'STRONG'; // no required skills listed -> don't penalize
  const set = new Set(profileSkills.map(s => s.toLowerCase()));
  const matched = requiredSkillNames.filter(s => set.has(s.toLowerCase())).length;
  const ratio = matched / requiredSkillNames.length;
  if (ratio >= 0.5) return 'STRONG';
  if (ratio > 0) return 'PARTIAL';
  return 'WEAK';
}

// Written rubric (spec Step 7), operationalized as a deterministic decision
// tree over roleFitTier/seniorityGapTier/skillOverlapTier — see
// docs/benchmark-v2-methodology.md for the prose version.
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

const BUCKET_TARGET = { A: 11, B: 4, C: 4, D: 4, E: 3, F: 2, G: 3, H: 2, I: 3 }; // sums to 36/profile — buffers against buckets with narrow filters returning fewer than requested

async function sampleBuckets(profile, target) {
  const fam = target.roleFamily, canon = target.canonicalRole;
  const seenIds = new Set();
  const buckets = {};

  async function add(bucket, sql, params) {
    const { rows } = await query(sql, params);
    buckets[bucket] = rows.filter(r => !seenIds.has(r.id)).slice(0, BUCKET_TARGET[bucket]);
    for (const r of buckets[bucket]) seenIds.add(r.id);
  }

  const cols = `id, title, role_family, canonical_role, seniority_level, min_exp_years, max_exp_years, salary_max_annual, employment_type, workplace_type`;

  // A. obvious target-role jobs
  if (profile.id === 'qa_automation') {
    await add('A',
      `SELECT ${cols} FROM jobs WHERE status='READY' AND (
         title ~* '\\y(qa automation engineer|sdet|software test engineer|test automation engineer|automation qa engineer|api test engineer|selenium engineer|playwright automation engineer)\\y'
       ) ORDER BY random() LIMIT $1`, [BUCKET_TARGET.A]);
  } else {
    await add('A', `SELECT ${cols} FROM jobs WHERE status='READY' AND canonical_role=$1 ORDER BY random() LIMIT $2`, [canon, BUCKET_TARGET.A]);
  }

  // B. adjacent-role jobs (same family, real ROLE_ADJACENCY-defined relation)
  await add('B', `SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 AND canonical_role IS NOT NULL AND canonical_role != $2 ORDER BY random() LIMIT $3`, [fam, canon, BUCKET_TARGET.B * 3]);
  buckets.B = buckets.B.filter(r => { const adj = roleAdjacency(r.canonical_role, canon); return adj != null && adj >= 0.55; }).slice(0, BUCKET_TARGET.B);

  // C. same-family but wrong-specialization jobs
  if (profile.id === 'qa_automation') {
    await add('C', `SELECT ${cols} FROM jobs WHERE status='READY' AND (
        title ~* '\\y(manufacturing quality engineer|electrical test engineer|systems test engineer|industrial automation engineer|validation engineer|hardware test engineer)\\y'
      ) ORDER BY random() LIMIT $1`, [BUCKET_TARGET.C]);
  } else {
    await add('C', `SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 AND canonical_role IS NOT NULL AND canonical_role NOT IN ($2, 'SOFTWARE_ENGINEER') ORDER BY random() LIMIT $3`, [fam, canon, BUCKET_TARGET.C * 3]);
    buckets.C = (buckets.C || []).filter(r => { const adj = roleAdjacency(r.canonical_role, canon); return adj == null || adj < 0.55; }).slice(0, BUCKET_TARGET.C);
  }

  // D. unrelated jobs with overlapping generic skills
  await add('D', `SELECT ${cols} FROM jobs j WHERE status='READY' AND role_family NOT IN ($1, 'OTHER')
      AND EXISTS (SELECT 1 FROM job_skills js JOIN skills s ON s.id=js.skill_id WHERE js.job_id=j.id AND s.normalized_name = ANY($2::text[]))
      ORDER BY random() LIMIT $3`, [fam, profile.skills, BUCKET_TARGET.D]);

  // E. seniority mismatch jobs (same family/role, far seniority)
  const wantSenior = profile.profile.totalExperienceYears >= 6;
  const seniorityFilter = wantSenior ? "seniority_level IN ('ENTRY','JUNIOR')" : "seniority_level IN ('STAFF','PRINCIPAL','DIRECTOR','EXECUTIVE')";
  await add('E', `SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 AND ${seniorityFilter} ORDER BY random() LIMIT $2`, [fam, BUCKET_TARGET.E]);

  // F. location/salary attractive but role-wrong
  await add('F', `SELECT ${cols} FROM jobs WHERE status='READY' AND role_family NOT IN ($1,'OTHER') AND workplace_type='REMOTE' AND salary_max_annual > 150000 ORDER BY random() LIMIT $2`, [fam, BUCKET_TARGET.F]);

  // G. low-signal/ambiguous jobs
  await add('G', `SELECT ${cols} FROM jobs WHERE status='READY' AND (role_family='OTHER' OR canonical_role IS NULL) AND title ~* '\\yengineer\\y' ORDER BY random() LIMIT $1`, [BUCKET_TARGET.G]);

  // H. hard-ineligible jobs (salary below minSalary, or non-full-time) — for eligibility validation, not quality labels
  await add('H', `SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 AND (salary_max_annual < $2 AND salary_max_annual IS NOT NULL) ORDER BY random() LIMIT $3`, [fam, profile.preferences.minSalary, Math.ceil(BUCKET_TARGET.H / 2)]);
  const hRest = BUCKET_TARGET.H - buckets.H.length;
  if (hRest > 0) {
    const { rows } = await query(`SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 AND employment_type NOT IN ('FULL_TIME','UNKNOWN') AND employment_type IS NOT NULL ORDER BY random() LIMIT $2`, [fam, hRest]);
    buckets.H.push(...rows.filter(r => !seenIds.has(r.id)));
    for (const r of rows) seenIds.add(r.id);
  }

  // I. randomly sampled eligible jobs (broad, family-agnostic)
  await add('I', `SELECT ${cols} FROM jobs WHERE status='READY' AND (role_family=$1 OR random() < 0.3) ORDER BY random() LIMIT $2`, [fam, BUCKET_TARGET.I]);

  // Top-up (spec Step 2's 30-minimum floor) — some buckets have narrow
  // filters and can legitimately return fewer than requested in a smaller
  // corpus slice; pad with more bucket-A-style (target canonical role)
  // jobs rather than leaving a profile under the floor.
  const total = Object.values(buckets).reduce((n, rows) => n + rows.length, 0);
  if (total < 30) {
    const { rows } = await query(`SELECT ${cols} FROM jobs WHERE status='READY' AND role_family=$1 ORDER BY random() LIMIT $2`, [fam, (30 - total) * 3]);
    const extra = rows.filter(r => !seenIds.has(r.id)).slice(0, 30 - total);
    for (const r of extra) seenIds.add(r.id);
    buckets.A = [...buckets.A, ...extra];
  }

  return buckets;
}

async function main() {
  mkdirSync('fixtures/benchmark-v2/labels', { recursive: true });
  const allProfilesOut = [];
  const distributionReport = [];

  for (const profile of PROFILES) {
    await query(`SELECT setseed($1)`, [(parseInt(createHash('sha256').update(profile.id).digest('hex').slice(0, 8), 16) % 1000) / 1000]);
    const target = profile.targetRoles[0];
    const buckets = await sampleBuckets(profile, target);

    const allSampled = Object.entries(buckets).flatMap(([bucket, rows]) => rows.map(r => ({ ...r, _bucket: bucket })));
    const jobIds = allSampled.map(r => r.id);
    const requiredSkillsMap = await fetchRequiredSkills(jobIds);

    const labels = {};
    const counts = { EXCELLENT: 0, GOOD: 0, BORDERLINE: 0, BAD: 0, HARD_INELIGIBLE: 0 };
    for (const job of allSampled) {
      if (job._bucket === 'H') {
        labels[job.id] = { label: 'HARD_INELIGIBLE', reasons: [job.salary_max_annual != null ? 'Salary below required minimum' : `Excluded employment type: ${job.employment_type}`], bucket: job._bucket, title: job.title };
        counts.HARD_INELIGIBLE++;
        continue;
      }
      const rf = roleFitTier(job, target);
      const sg = seniorityGapTier(profile.profile.totalExperienceYears, job.seniority_level);
      const required = requiredSkillsMap.get(job.id) || [];
      const so = skillOverlapTier(profile.skills, required);
      const { label, reasons } = decideLabel(rf, sg, so);
      labels[job.id] = { label, reasons, bucket: job._bucket, title: job.title, roleFitTier: rf, seniorityGapTier: sg, skillOverlapTier: so };
      counts[label]++;
    }

    writeFileSync(`fixtures/benchmark-v2/labels/${profile.id}.json`, JSON.stringify(labels, null, 2) + '\n');
    allProfilesOut.push(profile);
    distributionReport.push({ profileId: profile.id, total: allSampled.length, ...counts });
    console.log(`${profile.label.padEnd(24)} total=${allSampled.length}  EXCELLENT=${counts.EXCELLENT} GOOD=${counts.GOOD} BORDERLINE=${counts.BORDERLINE} BAD=${counts.BAD} HARD_INELIGIBLE=${counts.HARD_INELIGIBLE}`);
  }

  writeFileSync('fixtures/benchmark-v2/profiles.json', JSON.stringify({ profiles: allProfilesOut }, null, 2) + '\n');

  // Deterministic ~70/30 dev/holdout split (spec Step 10). Split on the
  // FULL sorted job-ID list per profile, not per label stratum — with
  // several small strata (e.g. 1-2 EXCELLENT jobs), a per-stratum modulo
  // split rounds every small stratum's holdout share down to 0, dragging
  // the profile's total holdout size below the >=10 floor even though the
  // overall ratio is close to 30%. A full-list split still lands
  // "approximately stratified" (spec's own wording) since label isn't
  // correlated with job id, while reliably hitting the size floor.
  const split = {};
  for (const profile of allProfilesOut) {
    const labels = JSON.parse(readFileSync(`fixtures/benchmark-v2/labels/${profile.id}.json`, 'utf8'));
    const sorted = Object.keys(labels).sort();
    const dev = [], holdout = [];
    sorted.forEach((id, i) => { (i % 3 === 2 ? holdout : dev).push(id); });
    split[profile.id] = { dev, holdout };
  }
  writeFileSync('fixtures/benchmark-v2/split.json', JSON.stringify(split, null, 2) + '\n');

  console.log('\n=== Label distribution ===');
  console.table(distributionReport);
  await closePool();
}

main().catch(e => { console.error(e.message); process.exit(1); });
