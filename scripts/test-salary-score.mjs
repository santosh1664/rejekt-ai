import { scoreSalary } from '../matching/salary-score.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

check('salary meets user minimum -> 100', scoreSalary(100000, { minAnnual: 90000, maxAnnual: 130000 }).score === 100);
check('salary below user minimum -> lower score, not zero', (() => { const s = scoreSalary(150000, { minAnnual: 90000, maxAnnual: 110000 }); return s.score < 100 && s.score >= 15; })());
check('unknown salary -> neutral, known:false, never treated as 0', (() => { const s = scoreSalary(150000, { minAnnual: null, maxAnnual: null }); return s.known === false && s.score > 0 && s.score < 100; })());
check('no user salary preference -> neutral', (() => { const s = scoreSalary(null, { minAnnual: 90000, maxAnnual: 110000 }); return s.known === true && s.score > 0 && s.score < 100; })());

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
