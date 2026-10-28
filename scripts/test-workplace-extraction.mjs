import { normalizeWorkplace } from '../lib/normalize.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

check('remote from location', normalizeWorkplace({ title: 'Engineer' }, 'Remote') === 'REMOTE');
check('remote from description phrasing', normalizeWorkplace({ title: 'Engineer' }, 'Austin, TX', 'This is a fully remote position.') === 'REMOTE');
check('hybrid from location', normalizeWorkplace({ title: 'Engineer' }, 'Hybrid - Austin, TX') === 'HYBRID');
check('hybrid from description phrasing', normalizeWorkplace({ title: 'Engineer' }, 'Austin, TX', 'This is a hybrid role, 3 days a week in-office.') === 'HYBRID');
check('onsite from bare location', normalizeWorkplace({ title: 'Engineer' }, 'Austin, TX') === 'ONSITE');
check(
  'benefits-paragraph false positive: bare "remote" mention does not flip an onsite role',
  normalizeWorkplace({ title: 'Engineer' }, 'Austin, TX', 'We offer great benefits including a remote-friendly culture and flexible PTO.') === 'ONSITE'
);
check('unknown when no location or description signal', normalizeWorkplace({ title: 'Engineer' }, '') === 'UNKNOWN');

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
