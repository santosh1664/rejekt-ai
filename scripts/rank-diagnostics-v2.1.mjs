/**
 * scripts/rank-diagnostics-v2.1.mjs
 *
 * Pure analysis over a benchmark-v2.1 dump (evaluate-recommendations-v2.1.mjs
 * --dump) — no DB access. Classifies every top-10 BORDERLINE/BAD job into
 * exactly one of spec Step 15's categories, using the benchmark's own
 * independent labelReasons (roleFitTier/seniorityGapTier/skillOverlapTier,
 * computed at build time from structured metadata only) cross-referenced
 * against the model's actual roleMatchType/component scores — not
 * per-job special-casing.
 *
 * Usage: node scripts/rank-diagnostics-v2.1.mjs evaluation/benchmark-v2.1-baseline-dev.json
 */
import { readFileSync } from 'fs';

const path = process.argv[2];
if (!path) { console.error('Usage: node scripts/rank-diagnostics-v2.1.mjs <dump.json>'); process.exit(1); }
const { jobs } = JSON.parse(readFileSync(path, 'utf8'));

const CATEGORIES = [
  'EXACT_CANONICAL_SKILL_GAP', 'SAME_FAMILY_GENERIC', 'DIFFERENT_FAMILY_RELATED', 'UNRELATED',
  'EXPERIENCE_MISMATCH', 'SENIORITY_MISMATCH', 'REQUIRED_SKILL_GAP', 'LOCATION_OVERRANK',
  'SALARY_OVERRANK', 'FRESHNESS_OVERRANK', 'CLASSIFICATION_ERROR', 'OTHER',
];

function classify(entry) {
  const c = entry.components;
  const mt = entry.roleMatchType;
  const reasons = (entry.labelReasons || []).join(' | ');
  const skillWeak = reasons.includes('Skill overlap: WEAK') || reasons.includes('Major required-skill gap');
  const seniorityBad = reasons.includes('Severe seniority mismatch') || reasons.includes('severe seniority gap') || reasons.includes('Seniority: SEVERE');

  // Role-match-type driven (model's own classification of role fit).
  if (mt === 'UNRELATED') return 'UNRELATED';
  if (mt === 'DIFFERENT_FAMILY_RELATED') return 'DIFFERENT_FAMILY_RELATED';

  // Benchmark's independent seniority signal takes priority over a generic
  // role-fit catch-all — this is what actually drove the BAD/BORDERLINE
  // label per the build-time rubric.
  if (seniorityBad) return 'SENIORITY_MISMATCH';

  if (mt === 'EXACT_CANONICAL') {
    if (skillWeak || (entry.missingRequiredSkills || []).length >= 2 || c.requiredSkills <= 30) return 'EXACT_CANONICAL_SKILL_GAP';
  }
  if (mt === 'SAME_FAMILY_GENERIC') {
    if (skillWeak || (entry.missingRequiredSkills || []).length >= 2) return 'REQUIRED_SKILL_GAP';
    return 'SAME_FAMILY_GENERIC';
  }
  if (skillWeak || (entry.missingRequiredSkills || []).length >= 2) return 'REQUIRED_SKILL_GAP';
  if (c.experience <= 40) return 'EXPERIENCE_MISMATCH';

  // Structural overrank checks — a weak/generic role score pulled up by one
  // dominant secondary component.
  if (c.role <= 65 && c.location >= 90 && (entry.finalScore - c.role) > 25) return 'LOCATION_OVERRANK';
  if (c.role <= 65 && c.freshness >= 90 && entry.rank <= 3) return 'FRESHNESS_OVERRANK';
  if (c.role <= 65 && c.salary >= 90) return 'SALARY_OVERRANK';

  return 'OTHER';
}

const top10 = jobs.filter(j => j.rank <= 10 && (j.label === 'BAD' || j.label === 'BORDERLINE'));
const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
for (const j of top10) counts[classify(j)]++;

console.log(`=== False-positive breakdown (top-10, BORDERLINE+BAD, n=${top10.length}) — ${path} ===`);
for (const cat of CATEGORIES) if (counts[cat] > 0) console.log(`${cat.padEnd(28)} ${counts[cat]}`);

console.log(`\n=== Top-5-only breakdown ===`);
const top5 = jobs.filter(j => j.rank <= 5 && (j.label === 'BAD' || j.label === 'BORDERLINE'));
const counts5 = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
for (const j of top5) counts5[classify(j)]++;
for (const cat of CATEGORIES) if (counts5[cat] > 0) console.log(`${cat.padEnd(28)} ${counts5[cat]}`);

// DIFFERENT_FAMILY_RELATED detail dump (spec Step 16) — every field the
// spec asks for, for every top-10 job the model itself classified this way
// (not limited to BAD/BORDERLINE — a GOOD/EXCELLENT DIFFERENT_FAMILY_RELATED
// top-10 job is equally informative for Step 17's genuine-vs-false-positive
// split).
const dfr = jobs.filter(j => j.rank <= 10 && j.roleMatchType === 'DIFFERENT_FAMILY_RELATED');
console.log(`\n=== DIFFERENT_FAMILY_RELATED, top-10, n=${dfr.length} ===`);
for (const j of dfr) {
  console.log(`\nProfile: ${j.profile}  |  Job: ${j.title}  |  rank=${j.rank}`);
  console.log(`  roleFamily=${j.roleFamily} canonicalRole=${j.canonicalRole}`);
  console.log(`  role=${j.components.role} reqSkill=${j.components.requiredSkills} prefSkill=${j.components.preferredSkills} exp=${j.components.experience} loc=${j.components.location} fresh=${j.components.freshness} sal=${j.components.salary}`);
  console.log(`  rawScore=${j.rawScore} finalScore=${j.finalScore} label=${j.label}  labelReasons=${(j.labelReasons||[]).join('; ')}`);
  console.log(`  missingRequiredSkills=${(j.missingRequiredSkills||[]).join(',')}`);
}
