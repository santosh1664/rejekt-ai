import { parseSalary, annualizeSalary } from '../lib/salary-extract.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

{
  const s = parseSalary('The salary range for this role is $120,000-$150,000 annually.');
  check('annual range', s.min === 120000 && s.max === 150000 && s.period === 'YEAR', JSON.stringify(s));
}
{
  const s = parseSalary('This position pays $60-$75/hour depending on experience.');
  check('hourly range', s.min === 60 && s.max === 75 && s.period === 'HOUR', JSON.stringify(s));
}
{
  const s = parseSalary('Salary: $150,000-$120,000 per year.');
  check('malformed range (min>max) rejected, not guessed', s.min === null && s.max === null, JSON.stringify(s));
}
{
  const a = annualizeSalary(60, 75, 'HOUR');
  check('annualize hourly does not mutate raw field, only the derived view', a.min === 124800 && a.max === 156000, JSON.stringify(a));
}
{
  const s = parseSalary('We are a great place to work with excellent benefits.');
  check('no salary mention -> nulls, not a guess', s.min === null && s.period === null);
}
{
  const s = parseSalary('Tuition Reimbursement up to $5,250 per year for ANY field of study.');
  check('tuition reimbursement benefit is not read as salary', s.min === null, JSON.stringify(s));
}
{
  const s = parseSalary('Below are some of the highlights: $4000/yr Travel Stipend to travel anywhere anytime.');
  check('travel stipend benefit is not read as salary', s.min === null, JSON.stringify(s));
}
{
  const s = parseSalary('Tuition Reimbursement up to $5,250 per year. The salary range for this role is $120,000-$150,000 annually.');
  check('a real salary mention is preferred over a co-occurring benefits figure', s.min === 120000 && s.max === 150000, JSON.stringify(s));
}
{
  const s = parseSalary('We offer generous perks and benefits. Below are some of the highlights: $4000/yr Travel Stipend to travel anywhere anytime. $350/mo AI Tools $150/mo Team lunch $500/one time Home office.');
  check('an itemized perks list with no single exclude keyword is still rejected via section detection', s.min === null, JSON.stringify(s));
}
{
  const s = parseSalary('The base salary for this role is $150,000-$180,000 per year. We also offer generous perks and benefits: $4000/yr Travel Stipend, $350/mo AI Tools.');
  check('a salary mention before a perks section is still found', s.min === 150000 && s.max === 180000, JSON.stringify(s));
}

console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
if (failures > 0) process.exit(1);
