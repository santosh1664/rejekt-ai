import { scoreExperience } from '../matching/experience-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

{
  const r = scoreExperience(5, { min: 3, max: 8 });
  check('meets years-based minimum -> 100', r.score === 100, JSON.stringify(r));
}
{
  const r = scoreExperience(2, { min: 8, max: null });
  check('2y vs 8y-min job scores meaningfully low (spec example)', r.score <= 20, JSON.stringify(r));
}
{
  // RANK-007: no min_exp_years posted -> previously always flat 90 regardless
  // of actual seniority gap. Now falls back to seniority_level.
  const r = scoreExperience(1, { min: null, max: null }, 'STAFF');
  check('entry-level user vs STAFF job with no years posted scores low, not neutral-90', r.score <= 40, JSON.stringify(r));
}
{
  const r = scoreExperience(10, { min: null, max: null }, 'SENIOR');
  check('experienced user vs SENIOR job with no years posted scores high', r.score >= 80, JSON.stringify(r));
}
{
  const r = scoreExperience(null, { min: null, max: null }, null);
  check('no years data and no seniority data -> neutral 90, unchanged fallback', r.score === 90);
}
{
  const r = scoreExperience(3, { min: null, max: null }, 'DIRECTOR');
  check('management-track role caps confidence even on an ordinal match', r.score <= 55, JSON.stringify(r));
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
