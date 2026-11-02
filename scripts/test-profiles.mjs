/**
 * scripts/test-profiles.mjs
 *
 * Resume profiles + resume extraction (docs/profile.md).
 *
 *   node scripts/test-profiles.mjs          # pure tests: extraction, normalization, derived fields
 *   DATABASE_URL=postgres://postgres@localhost:5432/jobs_test node scripts/test-profiles.mjs --db
 *                                           # + API end to end (inserts/deletes rows; localhost only)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { extractResumeSections, mergeExtracted, takeDates } from '../lib/resume-extract.mjs';
import {
  normalizeSections, normalizeMonth, totalExperienceYears, highestEducationLevel, currentTitle,
  completeness, deriveMatchingFields, withDefaults,
} from '../lib/resume-profiles.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const resume = name => readFileSync(join(ROOT, 'fixtures', 'resumes', name), 'utf8');
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

function extractionTests() {
  const a = extractResumeSections(resume('sample-a.txt'));
  check('A: contact details', a.personal.fullName === 'Alex Rivera' && a.personal.email === 'alex.rivera@example.com' && a.personal.phone === '(469) 555-0142'
    && a.personal.city === 'Dallas' && a.personal.state === 'TX' && /linkedin\.com\/in\/alexrivera/.test(a.personal.linkedin) && /github\.com\/alexr/.test(a.personal.github), a.personal);
  check('A: headline + summary', a.personal.headline === 'Software Engineer' && /^Software Engineer with 3\.5 years/.test(a.summary));
  check('A: two jobs with title/company/location/dates', JSON.stringify(a.experience.map(e => [e.title, e.company, e.location, e.startDate, e.endDate, e.current])) ===
    JSON.stringify([['Software Engineer', 'Northwind Bank', 'Remote', '2024-01', '', true], ['Software Developer', 'Bluefin Labs', 'Pune, India', '2021-06', '2023-07', false]]), a.experience);
  check('A: bullets attached, wrapped bullet line joined', a.experience[0].bullets.length === 2 && /from 2 days to 6 hours\.$/.test(a.experience[1].bullets[1]), a.experience[1].bullets);
  check('A: two schools back to back stay separate, GPA + field parsed', JSON.stringify(a.education.map(e => [e.school, e.degree, e.field, e.startDate, e.endDate, e.gpa])) ===
    JSON.stringify([['University of North Texas', 'Master of Science', 'Computer Science', '2023-08', '2025-05', '3.8/4.0'], ['Vellore Institute of Technology', 'B.Tech', 'Computer Science', '2017', '2021', '']]), a.education);
  check('A: projects with tech from "|" and " - " separators', a.projects.length === 2 && a.projects[0].technologies.join() === 'Python,LangChain,FastAPI,React' && a.projects[1].name === 'Job Radar' && a.projects[1].technologies.join() === 'Node.js,PostgreSQL', a.projects);
  check('A: grouped skills', a.skills.map(g => g.group).join('|') === 'Languages|Frameworks|Cloud & DevOps' && a.skills[0].items.includes('Java'));
  check('A: certification keeps en-dash name, issuer after spaced hyphen', a.certifications[0]?.name === 'AWS Certified Developer – Associate' && a.certifications[0].issuer === 'Amazon Web Services' && a.certifications[0].date === '2024', a.certifications);
  check('A: unknown headed section → custom', a.custom[0]?.title === 'Awards' && /Best Paper/.test(a.custom[0].body));

  const b = extractResumeSections(resume('sample-b.txt'));
  check('B: dot-separated header, portfolio link', b.personal.fullName === 'Jordan Lee' && b.personal.portfolio === 'https://jordanlee.dev' && b.personal.city === 'Austin');
  check('B: company line / title+location line / date line layout', JSON.stringify(b.experience.map(e => [e.company, e.title, e.location, e.startDate, e.current])) ===
    JSON.stringify([['Northwind Payments', 'Senior Backend Engineer', 'Austin, TX', '2022-03', true], ['Acme Corp', 'Backend Engineer', '', '2019', false]]), b.experience);
  check('B: "University of Texas at Austin" not split at "at"; degree/field split', b.education[0]?.school === 'University of Texas at Austin' && /^B\.S/.test(b.education[0].degree) && b.education[0].field === 'Computer Science', b.education);
  check('B: flat skills list → one group', b.skills.length === 1 && b.skills[0].items.length === 6);

  check('takeDates: ranges and "Present"', takeDates('Jan 2024 – Present').current === true && takeDates('06/2021 - 07/2023').endDate === '2023-07');
  check('empty text → empty sections', extractResumeSections('').experience.length === 0);

  const merged = mergeExtracted({ summary: 'Mine', experience: [], personal: { fullName: 'Edited Name' } }, a, 'fill');
  check('merge fill: keeps user edits, fills empty sections', merged.summary === 'Mine' && merged.personal.fullName === 'Edited Name' && merged.experience.length === 2 && merged.personal.email === 'alex.rivera@example.com');
  const replaced = mergeExtracted({ summary: 'Mine', personal: { fullName: 'Edited Name' } }, a, 'replace');
  check('merge replace: overwrites with resume data', replaced.summary !== 'Mine' && replaced.personal.fullName === 'Alex Rivera');
}

function modelTests() {
  check('normalizeMonth formats', normalizeMonth('Aug 2023') === '2023-08' && normalizeMonth('2023-8-15') === '2023-08' && normalizeMonth('8/2023') === '2023-08' && normalizeMonth('Present') === '');
  const n = normalizeSections({ bogus: 1, experience: [{ company: 'A', title: 'Dev', current: 'true', endDate: '2020-01', bullets: ['x', '', 'y'] }, {}], skills: ['Java', 'java', 'Go'],
    applicationDefaults: { needsSponsorship: 'yes', gender: 'Not an option', citizenship: 'India, United States', unknownField: 'x' } });
  check('normalize: drops unknown keys and empty entries', !('bogus' in n) && n.experience.length === 1 && n.experience[0].bullets.length === 2);
  check('normalize: current role clears end date', n.experience[0].current === true && n.experience[0].endDate === '');
  check('normalize: flat skills → one deduped group', n.skills.length === 1 && n.skills[0].items.join() === 'Java,Go');
  check('normalize: application defaults validated (bools, select options, unknown dropped)', n.applicationDefaults.needsSponsorship === true && !('gender' in n.applicationDefaults) && n.applicationDefaults.citizenship === 'India, United States' && !('unknownField' in n.applicationDefaults));
  check('normalize partial: only sent keys', Object.keys(normalizeSections({ summary: 'x' }, { partial: true })).join() === 'summary');

  const now = new Date(Date.UTC(2026, 9, 1));
  const years = totalExperienceYears([
    { startDate: '2021-06', endDate: '2023-07' },                 // 26 months
    { startDate: '2023-01', endDate: '2023-12' },                 // overlaps → merged to 2021-06..2023-12 = 31
    { startDate: '2024-01', current: true },                      // 2024-01..2026-10 = 34
  ], now);
  check('experience years merge overlaps and count current role to now', years === 5.4, years);
  check('highest education level', highestEducationLevel([{ degree: 'B.Tech' }, { degree: 'Master of Science' }]) === 'MASTERS' && highestEducationLevel([{ degree: 'Bachelor of Arts' }]) === 'BACHELORS');
  check('current title = current role', currentTitle([{ title: 'Old', startDate: '2019', endDate: '2020' }, { title: 'Now', startDate: '2024-01', current: true }]) === 'Now');

  const a = withDefaults(extractResumeSections(resume('sample-a.txt')));
  const c = completeness(a, { hasResume: true });
  check('completeness checklist from a full resume (no work-auth answers yet)', c.percent === 90 && c.items.find(i => i.key === 'authorization').done === false, c);
  check('completeness of empty profile', completeness({}).percent === 0);
  const d = deriveMatchingFields({ ...a, applicationDefaults: { needsSponsorship: true }, workAuth: [{ country: 'United States', authorized: true, needsSponsorship: true, status: 'Temporary work authorization' }] });
  check('derived matching fields', d.profile.current_title === 'Software Engineer' && d.profile.highest_education_level === 'MASTERS' && d.profile.needs_sponsorship === true
    && d.profile.work_authorization === 'Temporary work authorization' && d.skills.includes('Kubernetes') && d.profile.total_experience_years > 3, d);
}

async function apiTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.log('SKIP  --db: DATABASE_URL must point at localhost'); failures++; return; }
  const { query, closePool } = await import('../lib/db.mjs');
  const USER = '00000000-0000-4000-8000-0000000f11e5';
  const PORT = 3997;
  const cleanup = async () => {
    await query(`DELETE FROM resume_profiles WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_profiles WHERE user_id = $1`, [USER]);
  };
  await cleanup();
  const server = spawn(process.execPath, ['api/server.mjs', '--port', String(PORT)], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; server.stderr.on('data', d => { log += d; });
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    let r = await call('GET', `/users/${USER}/resume-profiles`);
    check('API: no profiles yet → []', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r);
    r = await call('POST', `/users/${USER}/resume-profiles`, { name: 'AI Engineer' });
    check('API: first profile is the default', r.status === 201 && r.body.isDefault === true && r.body.name === 'AI Engineer', r.body);
    const first = r.body.id;
    r = await call('POST', `/users/${USER}/resume-profiles/${first}/import-resume`, { text: resume('sample-a.txt'), filename: 'alex.pdf' });
    check('API: import-resume fills sections and reports counts', r.status === 200 && r.body.extracted.experience === 2 && r.body.profile.sections.education.length === 2 && r.body.profile.hasResume && r.body.profile.resumeFilename === 'alex.pdf', r.body?.extracted);
    r = await call('GET', `/users/${USER}/profile`);
    check('API: default profile synced into matching profile', r.body?.full_name === 'Alex Rivera' && r.body.current_title === 'Software Engineer' && r.body.highest_education_level === 'MASTERS', r.body);
    r = await call('GET', `/users/${USER}/skills`);
    check('API: skills synced into user_skills', r.body.length >= 10 && r.body.some(s => s.normalized_name === 'kubernetes'), r.body.length);

    r = await call('PATCH', `/users/${USER}/resume-profiles/${first}`, { sections: { applicationDefaults: { authorizedToWork: true, needsSponsorship: true, citizenship: 'India' } }, coverLetter: 'Dear team,' });
    check('API: PATCH replaces only the sent section; completeness reaches 100%', r.body.sections.experience.length === 2 && r.body.sections.applicationDefaults.needsSponsorship === true && r.body.coverLetter === 'Dear team,' && r.body.completeness.percent === 100, r.body.completeness);
    r = await call('GET', `/users/${USER}/profile`);
    check('API: sponsorship answer reaches matching', r.body.needs_sponsorship === true);

    r = await call('POST', `/users/${USER}/resume-profiles`, { name: 'Java Full Stack', copyFrom: first });
    check('API: copy a profile (not default)', r.status === 201 && r.body.isDefault === false && r.body.sections.experience.length === 2 && r.body.coverLetter === 'Dear team,', r.body);
    const second = r.body.id;
    await call('PATCH', `/users/${USER}/resume-profiles/${second}`, { sections: { summary: 'Java full stack engineer focused on Spring Boot and React applications for banking platforms.' } });
    r = await call('GET', `/users/${USER}/profile`);
    check('API: editing a non-default profile doesn\'t touch matching', r.body.summary !== 'Java full stack engineer focused on Spring Boot and React applications for banking platforms.');
    r = await call('POST', `/users/${USER}/resume-profiles/${second}/set-default`);
    check('API: set-default switches and syncs', r.body.isDefault === true);
    r = await call('GET', `/users/${USER}/resume-profiles`);
    check('API: exactly one default, list has completeness', r.body.filter(p => p.isDefault).length === 1 && r.body[0].id === second && r.body[0].completeness.percent > 0, r.body);
    r = await call('GET', `/users/${USER}/profile`);
    check('API: matching now uses the new default', /^Java full stack/.test(r.body.summary));

    r = await call('DELETE', `/users/${USER}/resume-profiles/${second}`);
    check('API: deleting the default promotes the other', r.status === 200 && (await call('GET', `/users/${USER}/resume-profiles/${first}`)).body.isDefault === true);
    r = await call('DELETE', `/users/${USER}/resume-profiles/${first}`);
    check('API: can\'t delete the last profile', r.status === 400, r);
    r = await call('POST', `/users/${USER}/resume-profiles/${first}/import-resume`, { text: 'short' });
    check('API: empty resume text → 400', r.status === 400);
    r = await call('GET', `/users/${USER}/resume-profiles/not-a-uuid`);
    check('API: bad id → 404', r.status === 404);
    r = await call('GET', `/profile/fields`);
    check('API: field definitions for forms', r.body.citizenship?.label === 'Countries of citizenship' && !r.body.workPermit && r.body.gender.options.includes('Prefer not to say'));
  } finally {
    server.kill();
    await cleanup();
    await closePool();
    if (failures) console.log(log.slice(-1500));
  }
}

extractionTests();
modelTests();
if (process.argv.includes('--db')) await apiTests();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
