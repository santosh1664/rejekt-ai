import { scoreRole } from '../matching/role-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

{
  const r = scoreRole({ canonicalRole: 'DATA_ENGINEER', roleFamily: 'DATA_SCIENCE' }, [{ canonicalRole: 'DATA_ENGINEER', roleFamily: 'DATA_SCIENCE', priority: 1 }]);
  check('exact canonical role match scores near-100', r.score >= 95 && r.matchType === 'EXACT_CANONICAL', JSON.stringify(r));
}
{
  const r = scoreRole(
    { canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', roleSpecialization: 'JAVA' },
    [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }],
    null, ['java', 'sql']
  );
  check('exact canonical role match + matching specialization scores full 100', r.score === 100, JSON.stringify(r));
}
{
  const r = scoreRole(
    { canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', roleSpecialization: 'JAVA' },
    [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }],
    null, ['python']
  );
  check('specialization mismatch does not penalize an exact canonical role match', r.score === 95, JSON.stringify(r));
}
{
  // Explicit adjacency (role-taxonomy.mjs) between two distinct, genuinely
  // finer canonical roles in the same family.
  const r = scoreRole(
    { canonicalRole: 'SITE_RELIABILITY_ENGINEER', roleFamily: 'DEVOPS_SRE' },
    [{ canonicalRole: 'DEVOPS_ENGINEER', roleFamily: 'DEVOPS_SRE', priority: 1 }]
  );
  check('related canonical role (explicit adjacency) scores moderately high', r.score >= 80 && r.score < 95 && r.matchType === 'RELATED_CANONICAL', JSON.stringify(r));
}
{
  // Both sides collapsed to family-level (old user_target_roles rows, or a
  // job the classifier could only place at low confidence) — must NOT be
  // treated as EXACT_CANONICAL even though the strings are equal.
  const r = scoreRole({ canonicalRole: 'DATA_SCIENCE', roleFamily: 'DATA_SCIENCE' }, [{ canonicalRole: 'DATA_SCIENCE', roleFamily: 'DATA_SCIENCE', priority: 1 }]);
  check('collapsed canonicalRole===roleFamily on both sides is SAME_FAMILY_GENERIC, not EXACT_CANONICAL', r.matchType === 'SAME_FAMILY_GENERIC' && r.score < 95, JSON.stringify(r));
}
{
  // Regression: two jobs both classified as the within-family GENERIC
  // catch-all (SOFTWARE_ENGINEER, from a bare "Software Engineer"/"Staff
  // Engineer"-with-no-specifics title) must not be treated as a genuine
  // specialization match either — found live via the dev benchmark's
  // "Entry Software Engineer" profile regressing to P@5=0 when unrelated
  // "Staff Engineer" hardware/aerospace titles all fell back to the same
  // generic bucket and false-matched EXACT_CANONICAL against it.
  const r = scoreRole(
    { canonicalRole: 'SOFTWARE_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', title: 'Staff Engineer, Digital Factory Lead' },
    [{ canonicalRole: 'SOFTWARE_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }]
  );
  check('two generic-fallback canonical roles matching is SAME_FAMILY_GENERIC, not EXACT_CANONICAL', r.matchType === 'SAME_FAMILY_GENERIC' && r.score < 95, JSON.stringify(r));
}
{
  // Same family, no adjacency defined between the two specific canonical
  // roles, no title given -> the generic same-family default.
  const r = scoreRole({ canonicalRole: 'DATA_ANALYST', roleFamily: 'DATA_SCIENCE' }, [{ canonicalRole: 'RESEARCH_SCIENTIST', roleFamily: 'DATA_SCIENCE', priority: 1 }]);
  check('same family, no defined adjacency, no title -> generic default (~50)', r.matchType === 'SAME_FAMILY_GENERIC' && r.score >= 40 && r.score <= 60, JSON.stringify(r));
}
{
  // Title similarity only kicks in as a tie-breaker within SAME_FAMILY_GENERIC.
  const r = scoreRole(
    { canonicalRole: 'DATA_SCIENCE', roleFamily: 'DATA_SCIENCE', title: 'Data Engineer' },
    [{ canonicalRole: 'DATA_SCIENCE', roleFamily: 'DATA_SCIENCE', priority: 1 }],
    'Senior Data Engineer'
  );
  check('title overlap nudges a same-family-generic match up', r.score > 50, JSON.stringify(r));
}
{
  const r = scoreRole({ canonicalRole: 'DEVOPS_SRE', roleFamily: 'DEVOPS_SRE' }, [{ canonicalRole: null, roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }]);
  check('adjacent-family match scores moderate, matchType DIFFERENT_FAMILY_RELATED', r.score > 30 && r.score < 80 && r.matchType === 'DIFFERENT_FAMILY_RELATED');
}
{
  const r = scoreRole({ canonicalRole: 'LEGAL', roleFamily: 'LEGAL' }, [{ canonicalRole: null, roleFamily: 'SOFTWARE_ENGINEERING', priority: 1 }]);
  check('unrelated field scores low, matchType UNRELATED', r.score <= 15 && r.matchType === 'UNRELATED');
}
check('no target roles -> neutral score, not zero', scoreRole({ canonicalRole: 'LEGAL', roleFamily: 'LEGAL' }, []).score === 50);
{
  const job = { canonicalRole: 'DATA_ENGINEER', roleFamily: 'DATA_SCIENCE' };
  const targets = [{ canonicalRole: 'LEGAL', roleFamily: 'LEGAL', priority: 1 }, { canonicalRole: 'DATA_ENGINEER', roleFamily: 'DATA_SCIENCE', priority: 2 }];
  const r = scoreRole(job, targets);
  check('priority weighting mildly discounts a match found only on a secondary target', r.score < 95 && r.matchType === 'EXACT_CANONICAL', JSON.stringify(r));
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
