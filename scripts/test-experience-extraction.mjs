import { classifyExperience } from '../lib/experience.mjs';

const cases = [
  { name: '3-5 years', text: 'Requirements: 3-5 years of experience needed.', expect: { min: 3, max: 5 } },
  { name: '5+ years', text: '5+ years of experience required.', expect: { min: 5, max: null } },
  { name: 'at least 2 years', text: 'At least 2 years of relevant experience.', expect: { min: 2, max: null } },
  { name: 'minimum of seven years', text: 'Minimum of seven years in a similar role.', expect: { min: 7, max: null } },
  { name: 'preferred experience', text: '2 years of experience preferred.', expect: { min: 2, max: null, requirementType: 'PREFERRED' } },
  { name: 'company-history false positive (in business)', text: 'We have been in business for over 20 years, serving happy customers.', expect: { min: null, max: null } },
  { name: 'company-history false positive (founded)', text: 'Founded 10 years ago, our company has grown rapidly.', expect: { min: null, max: null } },
  { name: 'no mention', text: 'We are looking for a great teammate to join our team.', expect: { min: null, max: null, requirementType: 'UNKNOWN' } },
];

let failures = 0;
for (const c of cases) {
  const result = classifyExperience(c.text);
  let pass = result.min === c.expect.min && result.max === c.expect.max;
  if (c.expect.requirementType) pass = pass && result.requirementType === c.expect.requirementType;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(45)} got min=${result.min} max=${result.max} type=${result.requirementType}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) process.exit(1);
