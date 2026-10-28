import { scoreSkills } from '../matching/skill-score.mjs';
import { normalizeSkillName } from '../lib/skills.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

{
  const r = scoreSkills(['python', 'aws'], { required: ['python', 'aws', 'kubernetes'], preferred: [], mentioned: [] });
  check('required overlap: 2/3 -> ~67', r.requiredScore === 67, JSON.stringify(r));
  check('missingRequired lists the gap', r.missingRequired.includes('kubernetes'));
}
{
  const r = scoreSkills(['kafka'], { required: [], preferred: ['kafka', 'snowflake'], mentioned: [] });
  check('preferred overlap: 1/2 -> 50', r.preferredScore === 50);
}
{
  // alias normalization: user's raw entry "Postgres" normalized before comparison
  const userSkills = ['postgres', 'k8s'].map(normalizeSkillName);
  const r = scoreSkills(userSkills, { required: ['postgresql', 'kubernetes'], preferred: [], mentioned: [] });
  check('alias normalization matches Postgres->PostgreSQL and K8s->Kubernetes', r.requiredScore === 100, JSON.stringify(r));
}
{
  const r = scoreSkills(['python'], { required: [], preferred: [], mentioned: ['python'] });
  check('zero required skills does not auto-score zero — neutral instead', r.requiredScore > 0 && r.requiredScore < 100);
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
