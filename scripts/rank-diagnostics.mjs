/**
 * scripts/rank-diagnostics.mjs
 *
 * Pure analysis over a dump produced by
 * `evaluate-recommendations.mjs --dump <path>` — no DB access, fast to
 * re-run on every tuning iteration. Produces:
 *   - false-positive failure-category counts for BORDERLINE/BAD jobs
 *     appearing in top-5/top-10 (spec Step 2)
 *   - per-bad-result score-contribution printout (Step 3)
 *   - score distribution (mean/median/quartiles) by label (Step 24)
 *   - component-vs-label correlation table (Step 25)
 *
 * Usage: node scripts/rank-diagnostics.mjs evaluation/dev-v1-baseline.json
 */
import { readFileSync } from 'fs';

const path = process.argv[2];
if (!path) { console.error('Usage: node scripts/rank-diagnostics.mjs <dump.json>'); process.exit(1); }
const { jobs } = JSON.parse(readFileSync(path, 'utf8'));

// ── Failure-category classification ─────────────────────────────────────
// Deterministic, evidence-based rules over the actual component scores —
// not per-job special-casing (spec Step 19's explicit ban).
// Recalibrated for the fine-grained canonical-role taxonomy (this phase):
// role score alone no longer maps cleanly to "genuine vs. generous" match
// quality (RELATED_CANONICAL and SAME_FAMILY_GENERIC now overlap in raw
// score range, ~55-65), so this classifies by the actual roleMatchType
// final-score.mjs now reports, not a score-threshold guess.
function classifyFailure(entry) {
  const c = entry.components;
  const reasons = [];
  const mt = entry.roleMatchType;
  if (mt === 'UNRELATED' || c.role <= 20) reasons.push('ROLE_MISMATCH');
  else if ((mt === 'SAME_FAMILY_GENERIC' || mt === 'DIFFERENT_FAMILY_RELATED' || mt == null) && c.role <= 65 && (c.requiredSkills >= 80 || c.preferredSkills >= 80)) reasons.push('SKILL_OVERLAP_OVERRANK');
  else if (mt === 'SAME_FAMILY_GENERIC' || mt === 'DIFFERENT_FAMILY_RELATED') reasons.push('RELATED_ROLE_TOO_GENEROUS');
  else if (mt == null && c.role <= 55) reasons.push('RELATED_ROLE_TOO_GENEROUS'); // dumps from before roleMatchType existed
  if (c.experience <= 40) reasons.push('EXPERIENCE_MISMATCH');
  if (entry.missingRequiredSkills.length >= 2) reasons.push('REQUIRED_SKILL_GAP');
  if (c.role >= 60 && c.location >= 90 && (entry.finalScore - c.role) > 25) reasons.push('LOCATION_OVERRANK');
  if (c.role >= 60 && c.freshness >= 90 && entry.rank <= 3) reasons.push('FRESHNESS_OVERRANK');
  if (c.role >= 60 && c.salary >= 90) reasons.push('SALARY_OVERRANK');
  if (reasons.length === 0) reasons.push('OTHER');
  return reasons;
}

const falsePositives = jobs.filter(j => j.rank <= 10 && (j.label === 'BAD' || j.label === 'BORDERLINE'));
const counts = {};
for (const fp of falsePositives) {
  for (const reason of classifyFailure(fp)) counts[reason] = (counts[reason] || 0) + 1;
}

console.log(`=== False-positive breakdown (top-10, BORDERLINE+BAD, n=${falsePositives.length}) ===`);
for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`${reason.padEnd(28)} ${n}`);
}

console.log(`\n=== Top-5-only breakdown ===`);
const fp5 = jobs.filter(j => j.rank <= 5 && (j.label === 'BAD' || j.label === 'BORDERLINE'));
const counts5 = {};
for (const fp of fp5) for (const reason of classifyFailure(fp)) counts5[reason] = (counts5[reason] || 0) + 1;
for (const [reason, n] of Object.entries(counts5).sort((a, b) => b[1] - a[1])) console.log(`${reason.padEnd(28)} ${n}`);

// ── Per-bad-result score contribution ────────────────────────────────────
console.log(`\n=== Score contribution detail (top-10 BAD only) ===`);
for (const j of jobs.filter(j => j.rank <= 10 && j.label === 'BAD')) {
  console.log(`\nProfile: ${j.profile}\nJob: ${j.title} | ${j.company}\nHuman label: ${j.label}\nRank: ${j.rank}  Final: ${j.finalScore}`);
  console.log(`  role=${j.components.role} requiredSkills=${j.components.requiredSkills} preferredSkills=${j.components.preferredSkills} experience=${j.components.experience} location=${j.components.location} freshness=${j.components.freshness} salary=${j.components.salary}`);
  console.log(`  Reasons: ${classifyFailure(j).join(', ')}`);
}

// ── Score distribution by label ──────────────────────────────────────────
function quartiles(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: s[s.length - 1] };
}
console.log(`\n=== Score distribution by label ===`);
for (const label of ['EXCELLENT', 'GOOD', 'BORDERLINE', 'BAD']) {
  const scores = jobs.filter(j => j.label === label).map(j => j.finalScore);
  if (!scores.length) continue;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const q = quartiles(scores);
  console.log(`${label.padEnd(12)} n=${scores.length}  mean=${mean.toFixed(1)}  median=${q.median}  q1=${q.q1}  q3=${q.q3}  min=${q.min}  max=${q.max}`);
}

// ── Component correlation by label ───────────────────────────────────────
console.log(`\n=== Average component score by label ===`);
const componentKeys = ['role', 'requiredSkills', 'preferredSkills', 'experience', 'location', 'freshness', 'salary'];
console.log(['label'.padEnd(12), ...componentKeys.map(k => k.padEnd(15))].join(''));
for (const label of ['EXCELLENT', 'GOOD', 'BORDERLINE', 'BAD']) {
  const rows = jobs.filter(j => j.label === label);
  if (!rows.length) continue;
  const avgs = componentKeys.map(k => (rows.reduce((a, r) => a + r.components[k], 0) / rows.length).toFixed(1).padEnd(15));
  console.log([label.padEnd(12), ...avgs].join(''));
}
