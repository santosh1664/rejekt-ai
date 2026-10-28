/**
 * scripts/test-jobs-filters.mjs
 *
 * API-level checks for the port-3000 /api/jobs endpoint against the
 * normalized skills/seniority model (see server.mjs). Requires the
 * server to be running (npm run start, or `node server.mjs`).
 *
 * Usage: node --env-file=.env.local scripts/test-jobs-filters.mjs
 */
const baseUrl = process.env.PORT3000_URL || 'http://localhost:3000';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function getJobs(query) {
  const res = await fetch(`${baseUrl}/api/jobs?${query}`);
  if (res.status !== 200) throw new Error(`${query}: expected 200, got ${res.status}`);
  return res.json();
}

async function main() {
  // ── Skills: any/all/none/unknown ──────────────────────────────────────
  {
    const data = await getJobs('skills=python&pageSize=5');
    check('skills=python returns jobs', data.jobs.length > 0);
    // canonical_name is properly-cased ("Python"), so compare case-insensitively.
    check('skills=python jobs actually have python in skills',
      data.jobs.every(j => [...j.skills.required, ...j.skills.preferred, ...j.skills.mentioned].some(s => s.toLowerCase() === 'python')),
      JSON.stringify(data.jobs[0]?.skills));
  }
  {
    const data = await getJobs('skills=k8s&pageSize=5'); // alias → kubernetes
    check('skills=k8s (alias) returns jobs normalized to kubernetes',
      data.jobs.every(j => [...j.skills.required, ...j.skills.preferred, ...j.skills.mentioned].some(s => s.toLowerCase() === 'kubernetes')));
  }
  {
    const data = await getJobs('skills=Spark&pageSize=5'); // search-only alias → apache spark
    check('skills=Spark (search-only alias) returns jobs normalized to Apache Spark',
      data.jobs.length > 0 && data.jobs.every(j => [...j.skills.required, ...j.skills.preferred, ...j.skills.mentioned].some(s => s.toLowerCase() === 'apache spark')));
  }
  {
    const [any, all] = await Promise.all([
      getJobs('skills=python,sql&skillMatch=any&pageSize=1'),
      getJobs('skills=python,sql&skillMatch=all&pageSize=1'),
    ]);
    check('skillMatch=all is more restrictive than skillMatch=any', all.total <= any.total, `all=${all.total} any=${any.total}`);
  }
  {
    const data = await getJobs('skills=zzz-nonexistent-skill&pageSize=5');
    check('skills=<nonexistent> returns zero jobs', data.total === 0);
  }

  // ── Seniority ──────────────────────────────────────────────────────────
  {
    const data = await getJobs('careerLevels=ENTRY&pageSize=5');
    check('careerLevels=ENTRY returns jobs', data.jobs.length > 0);
    check('careerLevels=ENTRY jobs are ENTRY or JUNIOR', data.jobs.every(j => ['ENTRY', 'JUNIOR'].includes(j.seniority_level)));
  }
  {
    const data = await getJobs('careerLevels=SENIOR&pageSize=5');
    check('careerLevels=SENIOR jobs are SENIOR or STAFF', data.jobs.every(j => ['SENIOR', 'STAFF'].includes(j.seniority_level)));
  }
  {
    const [unfiltered, filtered] = await Promise.all([
      getJobs('pageSize=1'),
      getJobs('careerLevels=EXECUTIVE&pageSize=1'),
    ]);
    check('unfiltered total includes UNKNOWN-seniority jobs (never hidden implicitly)', unfiltered.total > filtered.total);
  }

  // ── Regression: pre-existing filters still work ────────────────────────
  {
    const data = await getJobs('q=engineer&pageSize=5');
    check('title/company search still works', data.jobs.length > 0);
  }
  {
    const data = await getJobs('workplaceTypes=REMOTE&pageSize=5');
    check('workplace filter still works', data.jobs.every(j => j.workplace_type === 'REMOTE'));
  }
  {
    const data = await getJobs('pageSize=3');
    check('job card fields present (id/title/company/url)', data.jobs.every(j => j.id && j.title && j.company && j.url));
  }

  console.log(`\n${failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED'}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(err => { console.error('Test run failed:', err.message); process.exitCode = 1; });
