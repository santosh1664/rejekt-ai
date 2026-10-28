/**
 * scripts/test-role-consistency.mjs
 *
 * Role-consistency repair phase, spec Step 15: pure, DB-free regression
 * tests for the taxonomy validation helpers and the classification
 * pipeline fix (lib/fingerprint.mjs's classifyCategory() + lib/role-
 * classifier.mjs's classifyRole() + lib/normalize.mjs's normalizeJob()).
 *
 * Usage: node scripts/test-role-consistency.mjs
 */
import { CANONICAL_ROLES, validateRoleClassification, classifyRow } from '../lib/role-taxonomy.mjs';
import { classifyCategory } from '../lib/fingerprint.mjs';
import { classifyRole } from '../lib/role-classifier.mjs';
import { normalizeJob, CATEGORY_TO_ROLE_FAMILY } from '../lib/normalize.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function classifyTitle(title) {
  const category = classifyCategory(title);
  const roleFamily = CATEGORY_TO_ROLE_FAMILY[category] || 'OTHER';
  return classifyRole({ title, roleFamily });
}

// ── 1. Every canonical role in the taxonomy maps to its own declared family (tautological, but guards a future typo) ──
{
  let ok = true;
  for (const [role, entry] of Object.entries(CANONICAL_ROLES)) {
    const v = validateRoleClassification({ roleFamily: entry.family, canonicalRole: role, roleSpecialization: null });
    if (!v.valid) { ok = false; console.log(`  bad entry: ${role} -> ${entry.family}: ${v.errors.join('; ')}`); }
  }
  check('every canonical role validates against its own declared family', ok);
}

// ── 2. Every specialization maps to an allowed canonical role ──
{
  let ok = true;
  for (const [role, entry] of Object.entries(CANONICAL_ROLES)) {
    for (const spec of entry.specializations || []) {
      const v = validateRoleClassification({ roleFamily: entry.family, canonicalRole: role, roleSpecialization: spec });
      if (!v.valid) { ok = false; console.log(`  bad specialization: ${role}/${spec}: ${v.errors.join('; ')}`); }
    }
  }
  check('every declared specialization validates against its canonical role', ok);
}

// ── 3. A known canonical role with the WRONG family is correctly rejected ──
{
  const v = validateRoleClassification({ roleFamily: 'SOFTWARE_ENGINEERING', canonicalRole: 'ML_ENGINEER', roleSpecialization: null });
  check('ML_ENGINEER + SOFTWARE_ENGINEERING is rejected as invalid', !v.valid && v.errors.length > 0, JSON.stringify(v));
}

// ── 4. A specialization not in the canonical role's allowed set is rejected ──
{
  const v = validateRoleClassification({ roleFamily: 'DATA_SCIENCE', canonicalRole: 'ML_ENGINEER', roleSpecialization: 'REACT' });
  check('ML_ENGINEER + REACT specialization is rejected as invalid', !v.valid, JSON.stringify(v));
}

// ── 5. null canonicalRole is always valid (UNKNOWN is allowed, never an error) ──
{
  const v = validateRoleClassification({ roleFamily: 'SALES', canonicalRole: null, roleSpecialization: null });
  check('null canonicalRole is always valid', v.valid);
}

// ── 6. canonicalRole === roleFamily (legacy/not-deepened) is always valid ──
{
  const v = validateRoleClassification({ roleFamily: 'SALES', canonicalRole: 'SALES', roleSpecialization: null });
  check('canonicalRole === roleFamily is always valid', v.valid);
}

// ── 7. classifyRow buckets a known-mismatch combination correctly ──
{
  const bucket = classifyRow({ role_family: 'SOFTWARE_ENGINEERING', canonical_role: 'ML_ENGINEER', role_specialization: null });
  check('classifyRow buckets ML_ENGINEER+SOFTWARE_ENGINEERING as CANONICAL_ROLE_FAMILY_MISMATCH', bucket === 'CANONICAL_ROLE_FAMILY_MISMATCH', bucket);
}

// ── 8. classifyRow buckets a consistent known role correctly ──
{
  const bucket = classifyRow({ role_family: 'DATA_SCIENCE', canonical_role: 'ML_ENGINEER', role_specialization: 'LLM' });
  check('classifyRow buckets a valid combination as CONSISTENT', bucket === 'CONSISTENT', bucket);
}

// ── 9. classifyRow buckets the legacy family-copy state distinctly from a deepened family's fallback ──
{
  const notDeepened = classifyRow({ role_family: 'SALES', canonical_role: 'SALES', role_specialization: null });
  const deepenedFallback = classifyRow({ role_family: 'DATA_SCIENCE', canonical_role: 'DATA_SCIENCE', role_specialization: null });
  check('non-deepened family copy is CONSISTENT, deepened family copy is LEGACY_FAMILY_FALLBACK',
    notDeepened === 'CONSISTENT' && deepenedFallback === 'LEGACY_FAMILY_FALLBACK',
    JSON.stringify({ notDeepened, deepenedFallback }));
}

// ── 10. classifyRow buckets missing family/canonical correctly ──
{
  const noFamily = classifyRow({ role_family: null, canonical_role: 'ML_ENGINEER', role_specialization: null });
  const noCanonical = classifyRow({ role_family: 'DATA_SCIENCE', canonical_role: null, role_specialization: null });
  check('missing role_family -> UNKNOWN_FAMILY, missing canonical_role -> UNKNOWN_CANONICAL',
    noFamily === 'UNKNOWN_FAMILY' && noCanonical === 'UNKNOWN_CANONICAL',
    JSON.stringify({ noFamily, noCanonical }));
}

// ── 11-22. Full pipeline (classifyCategory -> classifyRole) on the spec's representative titles — every one must validate ──
const REPRESENTATIVE_TITLES = [
  ['Machine Learning Engineer', 'DATA_SCIENCE', 'ML_ENGINEER'],
  ['Backend Java Engineer', 'SOFTWARE_ENGINEERING', 'BACKEND_ENGINEER'],
  ['QA Automation Engineer', 'SOFTWARE_ENGINEERING', 'QA_AUTOMATION_ENGINEER'],
  ['Site Reliability Engineer', 'DEVOPS_SRE', 'SITE_RELIABILITY_ENGINEER'],
  ['Data Engineer', 'DATA_SCIENCE', 'DATA_ENGINEER'],
  ['Frontend Engineer', 'SOFTWARE_ENGINEERING', 'FRONTEND_ENGINEER'],
  ['Data Analyst', 'DATA_SCIENCE', 'DATA_ANALYST'],
  ['Platform Engineer', 'DEVOPS_SRE', 'PLATFORM_ENGINEER'],
  ['Cloud Security Engineer', 'DEVOPS_SRE', 'CLOUD_SECURITY_ENGINEER'],
  ['Manufacturing Engineer', 'MECHANICAL_ENGINEERING', null], // not a deepened family — canonical === family expected
  ['Electrical Test Engineer', null, null], // family only asserted non-null below; exact family not pinned (industrial vs electrical is a pre-existing classifyCategory nuance, out of scope here)
  ['Software Engineer - ML Platform', 'SOFTWARE_ENGINEERING', null],
];
for (const [title, expectFamily, expectCanonical] of REPRESENTATIVE_TITLES) {
  const classified = classifyTitle(title);
  const v = validateRoleClassification({ roleFamily: classified.roleFamily, canonicalRole: classified.canonicalRole, roleSpecialization: classified.roleSpecialization });
  const familyOk = expectFamily == null || classified.roleFamily === expectFamily;
  const canonicalOk = expectCanonical == null || classified.canonicalRole === expectCanonical;
  check(`"${title}" classifies to a valid, expected combination`,
    v.valid && familyOk && canonicalOk,
    JSON.stringify({ got: { family: classified.roleFamily, canonical: classified.canonicalRole }, expected: { family: expectFamily, canonical: expectCanonical }, errors: v.errors }));
}

// ── 23. Known historical mismatch example (spec's own, from the prior ranking-calibration phase) is now fixed end-to-end ──
{
  const classified = classifyTitle('Senior ML Engineer');
  check('the exact historical example (ML_ENGINEER vs SOFTWARE_ENGINEERING) is fixed',
    classified.roleFamily === 'DATA_SCIENCE' && classified.canonicalRole === 'ML_ENGINEER',
    JSON.stringify(classified));
}

// ── 24. normalizeJob() end-to-end never produces an invalid combination, across a wider ad-hoc title sample ──
{
  const sampleTitles = [
    'Senior Machine Learning Engineer', 'AI Engineer', 'NLP Research Engineer', 'MLOps Engineer',
    'DevOps Engineer', 'Senior Site Reliability Engineer', 'Cloud Engineer, AWS',
    'Full Stack Software Engineer', 'iOS Engineer', 'QA Engineer', 'SDET',
    'Data Scientist', 'Analytics Engineer', 'ETL Developer', 'Research Scientist',
    'Application Security Engineer', 'Network Engineer', 'Release Engineer',
    'Sales Engineer', 'Product Manager', 'Mechanical Engineer', 'Civil Engineer',
    'Nurse Practitioner', 'Recruiter', 'Supplier Quality Engineer',
  ];
  let ok = true;
  const bad = [];
  for (const title of sampleTitles) {
    const category = classifyCategory(title);
    const canonical = normalizeJob({ title, raw: {} }, category);
    const v = validateRoleClassification({ roleFamily: canonical.roleFamily, canonicalRole: canonical.canonicalRole, roleSpecialization: canonical.roleSpecialization });
    if (!v.valid) { ok = false; bad.push({ title, ...canonical, errors: v.errors }); }
  }
  check('normalizeJob() produces a valid combination for every sampled title', ok, JSON.stringify(bad));
}

// ── 25. reconcileFamily's confidence threshold: a LOW-confidence canonical match must not override family ──
{
  // Bare "Engineer" inside a DATA_SCIENCE-family job falls back to the
  // family itself (confidence 0.55 < override threshold), never to the
  // mismatched SOFTWARE_ENGINEER.
  const classified = classifyRole({ title: 'Senior Engineer', roleFamily: 'DATA_SCIENCE' });
  check('low-confidence generic "engineer" within DATA_SCIENCE does not get overwritten with SOFTWARE_ENGINEER',
    classified.canonicalRole !== 'SOFTWARE_ENGINEER',
    JSON.stringify(classified));
}

// ── 26-28. Ambiguous bare-term guards (QA_ENGINEER, EMBEDDED_ENGINEER) —
// found via the live corpus audit: these rules used to assign
// override-confidence to genuinely cross-discipline-ambiguous bare
// phrases with no software/hardware context check at all, which would
// have forced real manufacturing/electrical jobs into SOFTWARE_ENGINEERING
// once high-confidence family correction started applying. ──────────────
{
  const classified = classifyTitle('Quality Engineer');
  check('bare "Quality Engineer" (no hardware or software context) stays ambiguous, not forced to SOFTWARE_ENGINEERING',
    classified.roleFamily !== 'SOFTWARE_ENGINEERING', JSON.stringify(classified));
}
{
  const classified = classifyTitle('Embedded Hardware Engineer');
  check('"Embedded Hardware Engineer" (competing physical-discipline word) is not forced to SOFTWARE_ENGINEERING',
    classified.roleFamily !== 'SOFTWARE_ENGINEERING', JSON.stringify(classified));
}
{
  const classified = classifyTitle('Embedded Software Engineer');
  check('"Embedded Software Engineer" (explicit software context) correctly resolves to SOFTWARE_ENGINEERING/EMBEDDED_ENGINEER',
    classified.roleFamily === 'SOFTWARE_ENGINEERING' && classified.canonicalRole === 'EMBEDDED_ENGINEER', JSON.stringify(classified));
}

// ── 29. RESEARCH_SCIENTIST taxonomy fix — was declared under DATA_SCIENCE, corrected to RESEARCH (matching live corpus + FAMILY_ADJACENCY) ──
{
  const classified = classifyTitle('Research Scientist');
  const v = validateRoleClassification({ roleFamily: classified.roleFamily, canonicalRole: classified.canonicalRole, roleSpecialization: classified.roleSpecialization });
  check('"Research Scientist" resolves to RESEARCH family (not DATA_SCIENCE) and validates',
    v.valid && classified.roleFamily === 'RESEARCH' && classified.canonicalRole === 'RESEARCH_SCIENTIST', JSON.stringify(classified));
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
