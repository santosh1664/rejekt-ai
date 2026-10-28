import { classifySeniority } from '../lib/seniority.mjs';

const cases = [
  { name: 'senior title', job: { title: 'Senior Software Engineer' }, desc: '', minExp: null, expect: 'SENIOR' },
  { name: 'staff title', job: { title: 'Staff Data Scientist' }, desc: '', minExp: null, expect: 'STAFF' },
  { name: 'principal title', job: { title: 'Principal Backend Engineer' }, desc: '', minExp: null, expect: 'PRINCIPAL' },
  { name: 'director title', job: { title: 'Director of Engineering' }, desc: '', minExp: null, expect: 'DIRECTOR' },
  { name: 'manager title (excludes product manager)', job: { title: 'Product Manager' }, desc: '', minExp: null, expect: 'UNKNOWN' },
  { name: 'engineering manager', job: { title: 'Engineering Manager' }, desc: '', minExp: null, expect: 'MANAGER' },
  { name: 'intern title', job: { title: 'Software Engineering Intern' }, desc: '', minExp: null, expect: 'INTERN' },
  { name: 'entry via min_exp_years', job: { title: 'Software Engineer' }, desc: '', minExp: 0, expect: 'ENTRY' },
  { name: 'mid via min_exp_years', job: { title: 'Software Engineer' }, desc: '', minExp: 4, expect: 'MID' },
  { name: 'senior via min_exp_years', job: { title: 'Software Engineer' }, desc: '', minExp: 7, expect: 'SENIOR' },
  { name: 'numbered level II', job: { title: 'Software Engineer II' }, desc: '', minExp: null, expect: 'MID' },
  { name: 'description entry phrasing', job: { title: 'Software Engineer' }, desc: 'This is a great fit for new graduates.', minExp: null, expect: 'ENTRY' },
  { name: 'description management phrasing', job: { title: 'Team Lead' }, desc: 'Manages a team of 8 engineers.', minExp: null, expect: 'LEAD' }, // title rule (LEAD) wins over description
  { name: 'no signal at all', job: { title: 'Widget Specialist' }, desc: '', minExp: null, expect: 'UNKNOWN' },
];

let failures = 0;
for (const c of cases) {
  const result = classifySeniority(c.job, c.desc, c.minExp);
  const pass = result.level === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(45)} expected=${c.expect.padEnd(10)} got=${result.level}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) process.exit(1);
