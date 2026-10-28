import { classifyEducation } from '../lib/education.mjs';

const cases = [
  { name: 'required bachelors', text: "Bachelor's degree required.", expect: { level: 'BACHELORS', requirement: 'REQUIRED' } },
  { name: 'preferred bachelors', text: "Bachelor's degree preferred.", expect: { level: 'BACHELORS', requirement: 'PREFERRED' } },
  { name: 'degree or equivalent experience', text: "Bachelor's degree or equivalent experience.", expect: { level: 'BACHELORS', requirement: 'REQUIRED', equivalentExperienceAccepted: true } },
  { name: 'masters preferred', text: "Master's degree preferred for this role.", expect: { level: 'MASTERS', requirement: 'PREFERRED' } },
  { name: 'no mention', text: 'We value curiosity and a growth mindset.', expect: { level: 'UNKNOWN', requirement: 'UNKNOWN' } },
];

let failures = 0;
for (const c of cases) {
  const result = classifyEducation(c.text);
  let pass = result.level === c.expect.level && result.requirement === c.expect.requirement;
  if (c.expect.equivalentExperienceAccepted !== undefined) pass = pass && result.equivalentExperienceAccepted === c.expect.equivalentExperienceAccepted;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(35)} got level=${result.level} req=${result.requirement} equiv=${result.equivalentExperienceAccepted}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) process.exit(1);
