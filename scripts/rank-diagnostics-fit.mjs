/**
 * scripts/rank-diagnostics-fit.mjs
 *
 * Post-classification ranking calibration phase — Steps 2-4. Reads a dump
 * produced by evaluate-recommendations.mjs --dump (needs roleMatchType and
 * rawScore, both added this phase) and reports:
 *   - per-job detail for every top-10 ROLE_MISMATCH case (Step 2)
 *   - component averages/medians for ROLE_MISMATCH jobs vs. GOOD/EXCELLENT,
 *     BORDERLINE, BAD (Step 3)
 *   - professionalFit (role+requiredSkills+preferredSkills+experience) vs.
 *     preferenceFit (location+freshness+salary) averages by label (Step 4)
 *
 * Usage: node scripts/rank-diagnostics-fit.mjs <dump.json>
 */
import { readFileSync } from 'fs';

const path = process.argv[2];
if (!path) { console.error('Usage: node scripts/rank-diagnostics-fit.mjs <dump.json>'); process.exit(1); }
const { jobs } = JSON.parse(readFileSync(path, 'utf8'));

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Step 2: ROLE_MISMATCH per-job detail (top-10 only) ──────────────────
const roleMismatchTop10 = jobs.filter(j => j.rank <= 10 && j.roleMatchType === 'UNRELATED');
console.log(`=== Step 2: top-10 ROLE_MISMATCH (roleMatchType=UNRELATED) jobs (n=${roleMismatchTop10.length}) ===\n`);
for (const j of roleMismatchTop10) {
  const c = j.components;
  console.log(`${j.profile} | ${j.title} | rank=${j.rank} | label=${j.label ?? 'unlabeled'}`);
  console.log(`  roleFamily=${j.roleFamily} canonicalRole=${j.canonicalRole ?? 'null'} roleMatchType=${j.roleMatchType}`);
  console.log(`  role=${c.role} requiredSkills=${c.requiredSkills} preferredSkills=${c.preferredSkills} experience=${c.experience} location=${c.location} freshness=${c.freshness} salary=${c.salary}`);
  console.log(`  rawScore=${j.rawScore} finalScore=${j.finalScore}\n`);
}

// ── Step 3: component contribution analysis by label ─────────────────────
console.log(`=== Step 3: component averages/medians — ROLE_MISMATCH vs. label buckets (top-10 only) ===\n`);
const buckets = {
  ROLE_MISMATCH: roleMismatchTop10,
  'GOOD/EXCELLENT': jobs.filter(j => j.rank <= 10 && (j.label === 'GOOD' || j.label === 'EXCELLENT')),
  BORDERLINE: jobs.filter(j => j.rank <= 10 && j.label === 'BORDERLINE'),
  BAD: jobs.filter(j => j.rank <= 10 && j.label === 'BAD'),
};
const fields = ['role', 'requiredSkills', 'preferredSkills', 'experience', 'location', 'freshness', 'salary'];
console.log(['bucket'.padEnd(16), 'n'.padEnd(4), ...fields.map(f => f.padEnd(14))].join(''));
for (const [name, list] of Object.entries(buckets)) {
  const avgs = fields.map(f => mean(list.map(j => j.components[f])));
  const meds = fields.map(f => median(list.map(j => j.components[f])));
  console.log([name.padEnd(16), String(list.length).padEnd(4), ...avgs.map(v => (v == null ? '-' : v.toFixed(1)).padEnd(14))].join(''), '(avg)');
  console.log([''.padEnd(16), ''.padEnd(4), ...meds.map(v => (v == null ? '-' : v.toFixed(1)).padEnd(14))].join(''), '(median)');
}

// ── Step 4: professionalFit vs preferenceFit by label ────────────────────
console.log(`\n=== Step 4: professionalFit vs preferenceFit by label (top-10 only) ===\n`);
function professionalFit(c) { return (c.role + c.requiredSkills + c.preferredSkills + c.experience) / 4; }
function preferenceFit(c) { return (c.location + c.freshness + c.salary) / 3; }
for (const [name, list] of Object.entries(buckets)) {
  const pf = mean(list.map(j => professionalFit(j.components)));
  const prf = mean(list.map(j => preferenceFit(j.components)));
  console.log(`${name.padEnd(16)} n=${String(list.length).padEnd(4)} professionalFit avg=${pf == null ? '-' : pf.toFixed(1)}  preferenceFit avg=${prf == null ? '-' : prf.toFixed(1)}`);
}
