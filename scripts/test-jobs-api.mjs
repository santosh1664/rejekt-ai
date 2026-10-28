const endpoints = [
  '/jobs?limit=1',
  '/jobs?limit=25',
  '/jobs?q=data',
  '/jobs?sort=salary',
  '/jobs?sort=experience',
  '/jobs?role_family=DATA_SCIENCE',
  '/jobs?workplace_type=REMOTE',
  '/jobs?employment_type=FULL_TIME',
  '/jobs?sponsorship_status=UNKNOWN',
  '/jobs?experience_max=5',
  '/jobs?salary_min=100000',
  '/jobs?state=TX',
  '/jobs?skills=python',
  '/jobs?role_family=DATA_SCIENCE&state=TX',
  '/jobs?workplace_type=REMOTE&experience_max=5',
  '/jobs?salary_min=100000&employment_type=FULL_TIME',
];

const baseUrl = process.env.API_URL || 'http://localhost:3001';
let failures = 0;
for (const endpoint of endpoints) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  if (response.status !== 200) {
    failures++;
    console.error(`${endpoint}: expected 200, got ${response.status}`);
  }
}
if (failures > 0) process.exit(1);
console.log(`jobs API checks passed: ${endpoints.length}`);
