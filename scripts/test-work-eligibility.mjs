import { classifySponsorship, classifyCitizenship, classifyClearance } from '../lib/work-eligibility.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Sponsorship ────────────────────────────────────────────────────────────
check('explicit no sponsorship', classifySponsorship('We do not sponsor visas at this time.').status === 'NO_SPONSORSHIP');
check('no visa sponsorship phrasing', classifySponsorship('No visa sponsorship is available for this role.').status === 'NO_SPONSORSHIP');
check('without current or future sponsorship', classifySponsorship('We are unable to sponsor employment visas, now or in the future, without current or future visa sponsorship.').status === 'NO_SPONSORSHIP');
check('sponsorship available', classifySponsorship('H-1B sponsorship available for qualified candidates.').status === 'SPONSORS');
check('OPT considered -> may sponsor', classifySponsorship('OPT candidates are considered for this role.').status === 'MAY_SPONSOR');
check('must be authorized (no sponsorship word) stays UNKNOWN', classifySponsorship('Must be authorized to work in the United States.').status === 'UNKNOWN');
check('absence of language -> UNKNOWN', classifySponsorship('We are looking for a great engineer to join our team.').status === 'UNKNOWN');

// ── Citizenship ─────────────────────────────────────────────────────────────
check('citizen required', classifyCitizenship('U.S. citizens only need apply.').required === 'US');
check('work authorization only is NOT citizenship', classifyCitizenship('Must be authorized to work in the U.S.').required === null);
check('ITAR restriction flagged', classifyCitizenship('Must be a U.S. citizen due to ITAR requirements.').itarRelated === true);
check('ITAR alone (no citizen word) does not assert citizenship', classifyCitizenship('This role involves ITAR-controlled technical data.').required === null);

// ── Clearance ────────────────────────────────────────────────────────────────
{
  const c = classifyClearance('Active Secret clearance required for this position.');
  check('active Secret -> SECRET/REQUIRED_NOW', c.type === 'SECRET' && c.requirement === 'REQUIRED_NOW');
}
{
  const c = classifyClearance('Must be eligible to obtain a Secret clearance.');
  check('eligible to obtain -> SECRET/ELIGIBLE_TO_OBTAIN', c.type === 'SECRET' && c.requirement === 'ELIGIBLE_TO_OBTAIN');
}
{
  const c = classifyClearance('TS/SCI preferred but not required.');
  check('TS/SCI preferred -> TS_SCI/PREFERRED', c.type === 'TS_SCI' && c.requirement === 'PREFERRED');
}
{
  const c = classifyClearance('Join our team building next-generation rockets and spacecraft.');
  check('defense-adjacent posting with no clearance language -> NONE (not auto-required)', c.type === 'NONE' && c.requirement === 'NONE');
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
