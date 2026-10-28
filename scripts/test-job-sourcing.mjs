/**
 * scripts/test-job-sourcing.mjs
 *
 * Tests for the job-sourcing additions (docs/job-sourcing.md):
 *   - the six new ATS providers, run against real captured API responses
 *     (fixtures/sourcing/) with fetch mocked — no network needed
 *   - lib/ats-detect.mjs on real job URLs seen in Tsenta's feed
 *   - openings grouping in the feed
 *   - --db: "add a job by link" end to end against a local database
 *
 *   node scripts/test-job-sourcing.mjs
 *   DATABASE_URL=postgres://postgres@localhost:5432/jobs_test node scripts/test-job-sourcing.mjs --db
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sourcing');
const fixture = name => readFileSync(join(FIX, name), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// ── fetch mock: URL pattern → fixture body ─────────────────────────────────
const ROUTES = [
  [/8westconsulting\.recruitee\.com\/api\/offers$/, 'recruitee-8westconsulting.json'],
  [/londontech\.recruitee\.com\/api\/offers$/, 'recruitee-londontech.json'],
  [/motivosity\.breezy\.hr\/json$/, 'breezy-motivosity.json'],
  [/collab\.pinpointhq\.com\/postings\.json$/, 'pinpoint-collab.json'],
  [/board\/aalo-atomics\/jobs\/8d4783fb-b22c-4cfd-ae34-81d4b2ad628f$/, 'rippling-aalo-atomics-detail.json'],
  [/board\/aalo-atomics\/jobs$/, 'rippling-aalo-atomics-list.json'],
  [/lumapps\.teamtailor\.com\/jobs\.rss$/, 'teamtailor-lumapps.rss'],
  [/jpmc\.fa\.oraclecloud\.com\/hcmRestApi\/resources\/latest\/recruitingCEJobRequisitions/, 'oraclecloud-jpmc.json'],
];
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const hit = ROUTES.find(([re]) => re.test(String(url)));
  if (!hit) return new Response('not found', { status: 404, statusText: 'Not Found' });
  return new Response(fixture(hit[1]), { status: 200, headers: { 'Content-Type': hit[1].endsWith('.rss') ? 'application/rss+xml' : 'application/json' } });
};

const iso = s => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && s.endsWith('Z');

async function providerTests() {
  const { fetchAll: recruitee } = await import('../providers/recruitee.mjs');
  let jobs = await recruitee({ name: '8 West Consulting', slug: '8westconsulting' });
  check('recruitee: parses the offer', jobs.length === 1 && jobs[0].title === 'Senior Python Developer', jobs);
  check('recruitee: published_at → exact ISO time (matches Tsenta datePosted 13:27:46)', jobs[0].posted_at === '2026-10-23T13:27:46.000Z', jobs[0].posted_at);
  check('recruitee: remote + country code + description from description+requirements',
    jobs[0].remote === true && jobs[0].countryCode === 'IE' && /Key Responsibilities/.test(jobs[0].raw.description), jobs[0]);
  check('recruitee: careers url', jobs[0].url === 'https://8westconsulting.recruitee.com/o/senior-python-developer');

  const { fetchAll: breezy } = await import('../providers/breezy.mjs');
  jobs = await breezy({ name: null, slug: 'motivosity' });
  check('breezy: two positions, company name from payload when unknown', jobs.length === 2 && jobs[0].company === 'Motivosity', jobs.map(j => j.company));
  check('breezy: Lehi, UT location + US country + posted date', jobs[0].location === 'Lehi, UT' && jobs[0].countryCode === 'US' && jobs[0].posted_at === '2026-06-26T16:23:09.195Z', jobs[0]);

  const { fetchAll: pinpoint } = await import('../providers/pinpoint.mjs');
  jobs = await pinpoint({ name: 'Collab', slug: 'collab' });
  check('pinpoint: postings with section-joined description', jobs.length === 2 && /Key Responsibilities/.test(jobs[0].raw.description), jobs[0]?.raw?.description?.slice(0, 80));
  check('pinpoint: onsite, no posted date exposed', jobs[0].remote === false && jobs[0].posted_at === null);

  const { fetchAll: rippling } = await import('../providers/rippling.mjs');
  calls.length = 0;
  jobs = await rippling({ name: null, slug: 'aalo-atomics' });
  check('rippling: list + detail calls', calls.filter(u => /aalo-atomics\/jobs\//.test(u)).length === 2, calls);
  const withDetail = jobs.find(j => j.raw.id === '8d4783fb-b22c-4cfd-ae34-81d4b2ad628f');
  check('rippling: detail fills createdOn (tz-converted), description, company name',
    withDetail.posted_at === '2026-05-06T20:32:50.826Z' && /AI Platform Engineer/.test(withDetail.raw.description) && withDetail.company === 'Aalo Atomics', withDetail);
  const noDetail = jobs.find(j => j.raw.id === '7f01827b-9bb6-4bb1-9e2e-8769c118211e');
  check('rippling: a failed detail call still keeps the job from list data', noDetail && noDetail.location === 'Austin, TX' && noDetail.posted_at === null, noDetail);

  const { fetchAll: teamtailor, parseTeamtailorRss } = await import('../providers/teamtailor.mjs');
  jobs = await teamtailor({ name: 'LumApps', slug: 'lumapps' });
  check('teamtailor: two RSS items', jobs.length === 2, jobs.length);
  check('teamtailor: entities decoded, pubDate → UTC ISO, custom-domain link kept',
    jobs[0].raw.description.startsWith('<p><strong>LumApps') && jobs[0].posted_at === '2026-10-20T12:30:10.000Z' && jobs[0].url === 'https://job.lumapps.com/jobs/8576188-product-director', jobs[0]);
  check('teamtailor: multi-location + Austin item', jobs[0].location === 'Paris, France; Tassin-la-Demi-Lune, France' && jobs[1].location === 'Austin, United States', jobs.map(j => j.location));
  check('teamtailor: hybrid isn\'t remote', jobs[0].remote === false);
  check('teamtailor: parser tolerates empty input', parseTeamtailorRss('').length === 0);

  const { fetchAll: oracle, oracleTarget } = await import('../providers/oraclecloud.mjs');
  calls.length = 0;
  jobs = await oracle({ name: 'JPMorgan Chase', slug: 'jpmc.fa.oraclecloud.com/CX_1002', meta: {} });
  check('oracle: requisitions → jobs with candidate-experience URLs',
    jobs.length === 2 && jobs[0].url === 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/210702452', jobs[0]?.url);
  check('oracle: date-only PostedDate → midnight UTC, country passthrough', jobs[0].posted_at === '2026-10-23T00:00:00.000Z' && jobs[1].countryCode === 'KR');
  check('oracle: stops after a short page (no runaway pagination)', calls.length === 1, calls.length);
  check('oracle: meta takes precedence over slug', oracleTarget({ slug: 'a/b', meta: { host: 'h.oraclecloud.com', site: 'CX_9' } }).site === 'CX_9');

  const { classifyJobCountry, isJobInCoverage } = await import('../lib/geo.mjs');
  check('geo: structured countryCode wins over location text', classifyJobCountry({ ats: 'oraclecloud', location: 'Seoul', countryCode: 'KR' }) === 'OTHER'
    && classifyJobCountry({ ats: 'breezy', location: 'Somewhere', countryCode: 'us' }) === 'US');
  check('geo: Canada / EU / Australia are in coverage, other countries are not',
    classifyJobCountry({ ats: 'ashby', location: 'x', raw: { address: { postalAddress: { addressCountry: 'Canada' } } } }) === 'CA'
    && classifyJobCountry({ location: 'Berlin, Germany' }) === 'EU'
    && classifyJobCountry({ location: 'Sydney, Australia' }) === 'AU'
    && isJobInCoverage({ location: 'Toronto, Canada' }) && isJobInCoverage({ location: 'Munich' }) && isJobInCoverage({ location: 'Melbourne' })
    && !isJobInCoverage({ location: 'London, UK' }) && !isJobInCoverage({ ats: 'oraclecloud', location: 'Seoul', countryCode: 'KR' })
    && isJobInCoverage({ location: 'Remote' }));

  const { PROVIDERS } = await import('../scanner/worker.mjs');
  const { ATS_CONCURRENCY } = await import('../lib/pool.mjs');
  const added = ['recruitee', 'breezy', 'pinpoint', 'rippling', 'teamtailor', 'oraclecloud'];
  check('scanner registry + concurrency pools include all new providers', added.every(a => typeof PROVIDERS[a] === 'function' && ATS_CONCURRENCY[a] > 0));
}

function detectTests(detectAts, canonicalJobUrl, findPastedJob) {
  // Real job URLs served by Tsenta on 2026-10-23 (see docs/job-sourcing.md).
  const cases = [
    ['https://jobs.ashbyhq.com/legora/c3c6e7d1-b4e8-488e-9481-d0e1fb996761', 'ashby', 'legora', 'c3c6e7d1-b4e8-488e-9481-d0e1fb996761'],
    ['https://jobs.lever.co/gohighlevel/01aa8ff3-d250-40a1-89e2-5341f66f1a36', 'lever', 'gohighlevel', '01aa8ff3-d250-40a1-89e2-5341f66f1a36'],
    ['https://boards.greenhouse.io/stripe/jobs/6094561', 'greenhouse', 'stripe', '6094561'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/123', 'greenhouse', 'acme', '123'],
    ['https://boards.greenhouse.io/embed/job_app?for=figma&token=555', 'greenhouse', 'figma', '555'],
    ['https://jobs.smartrecruiters.com/ServiceNow/744000153333219-sr-software-engineer', 'smartrecruiters', 'servicenow', '744000153333219'],
    ['https://apply.workable.com/acme/j/ABC123/', 'workable', 'acme', 'ABC123'],
    ['https://yahara.bamboohr.com/careers/91', 'bamboohr', 'yahara', '91'],
    ['https://remitly.wd5.myworkdayjobs.com/remitly_careers/job/Seattle-Washington-United-States/AI-Native-Software-Engineer_R-12345', 'workday', 'remitly/remitly_careers', 'R-12345'],
    ['https://8westconsulting.recruitee.com/o/senior-python-developer', 'recruitee', '8westconsulting', 'senior-python-developer'],
    ['https://motivosity.breezy.hr/p/91f3de081402-ai-product-builder/apply', 'breezy', 'motivosity', '91f3de081402'],
    ['https://collab.pinpointhq.com/en/postings/1428b768-fcb5-4fd6-988c-f301cdae338c/applications/new', 'pinpoint', 'collab', '1428b768-fcb5-4fd6-988c-f301cdae338c'],
    ['https://ats.rippling.com/aalo-atomics/jobs/7f01827b-9bb6-4bb1-9e2e-8769c118211e', 'rippling', 'aalo-atomics', '7f01827b-9bb6-4bb1-9e2e-8769c118211e'],
    ['https://ats.rippling.com/en-GB/rippling/jobs/9f16d650-09aa-4b81-8ddc-db07adab43b6', 'rippling', 'rippling', '9f16d650-09aa-4b81-8ddc-db07adab43b6'],
    ['https://lumapps.teamtailor.com/jobs/8554000-forward-deployed-engineer-toronto', 'teamtailor', 'lumapps', '8554000'],
    ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/210797568', 'oraclecloud', 'jpmc.fa.oraclecloud.com/CX_1002', '210797568'],
  ];
  for (const [url, ats, slug, jobId] of cases) {
    const d = detectAts(url);
    check(`detect ${ats}: ${url.slice(8, 60)}…`, d?.supported && d.ats === ats && d.slug === slug && d.jobId === jobId, d);
  }
  const wd = detectAts('https://remitly.wd5.myworkdayjobs.com/en-US/remitly_careers/job/X_R1');
  check('detect workday: locale segment skipped, meta for the provider', wd.meta.tenant === 'remitly' && wd.meta.shard === 'wd5' && wd.meta.site === 'remitly_careers', wd);
  const or = detectAts('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/1');
  check('detect oracle: meta host + site', or.meta.host === 'jpmc.fa.oraclecloud.com' && or.meta.site === 'CX_1002');

  const unsupported = [
    ['https://careers-peraton.icims.com/jobs/167302/ai-ml-software-engineer/job', 'icims'],
    ['https://jobs.jobvite.com/equitymethods/job/owW0zfwL', 'jobvite'],
    ['https://luxerone.zohorecruit.com/jobs/Careers/549274000031528068/Staff-Software-Engineer-AI', 'zohorecruit'],
    ['https://career55.sapsf.eu/career?career_job_req_id=207559', 'successfactors'],
    ['https://app.dover.com/apply/2c920eb6/0e00a54b', 'dover'],
    ['https://jobs.gusto.com/postings/mindhat-llc-senior-engineer/applicants/new', 'gusto'],
    ['https://www.linkedin.com/jobs/view/123', 'linkedin'],
  ];
  for (const [url, ats] of unsupported) {
    const d = detectAts(url);
    check(`recognized but unsupported: ${ats}`, d && d.supported === false && d.ats === ats, d);
  }
  check('unknown site → supported:false, ats:null', (() => { const d = detectAts('https://careers.example.com/jobs/1'); return d.supported === false && d.ats === null; })());
  check('not a URL → null', detectAts('software engineer') === null && detectAts('ftp://x/y') === null);
  check('reserved subdomains are not slugs', detectAts('https://www.recruitee.com/o/x').supported === false);

  check('canonicalJobUrl strips apply suffix, query, trailing slash and locale',
    canonicalJobUrl('https://Motivosity.breezy.hr/p/91f3-ai/apply?src=x') === 'motivosity.breezy.hr/p/91f3-ai'
    && canonicalJobUrl('https://ats.rippling.com/en-GB/acme/jobs/u1') === canonicalJobUrl('https://ats.rippling.com/acme/jobs/u1'));
  const board = [{ url: 'https://motivosity.breezy.hr/p/91f3de081402-ai-product-builder', raw: { id: '91f3de081402' } }, { url: 'https://motivosity.breezy.hr/p/fde3-ae', raw: { id: 'fde3' } }];
  check('findPastedJob: apply-page link resolves to the posting', findPastedJob(board, 'https://motivosity.breezy.hr/p/91f3de081402-ai-product-builder/apply', '91f3de081402') === board[0]);
  check('findPastedJob: falls back to the ATS job id', findPastedJob(board, 'https://motivosity.breezy.hr/p/fde3-renamed-title', 'fde3') === board[1]);
  check('findPastedJob: unknown job → null', findPastedJob(board, 'https://motivosity.breezy.hr/p/zzz', 'zzz') === null);
}

function groupingTests(groupOpenings) {
  const mk = (id, company, title, score, loc) => ({ job: { jobId: id, company, title, url: `https://x/${id}`, locationText: loc }, finalScore: score });
  const out = groupOpenings([
    mk('1', 'ServiceNow', 'Sr Software Engineer', 80, 'Santa Clara, CA'),
    mk('2', 'Acme', 'Backend Engineer', 75, 'Austin, TX'),
    mk('3', 'servicenow ', 'Sr. Software Engineer', 70, 'San Diego, CA'),
    mk('4', 'ServiceNow', 'Staff Software Engineer', 65, 'Santa Clara, CA'),
  ]);
  check('grouping: same company + normalized title collapse (Sr./Sr, case, spaces)', out.length === 3 && out[0].siblings.length === 1 && out[0].siblings[0].jobId === '3', out.map(o => [o.job.jobId, o.siblings.map(s => s.jobId)]));
  check('grouping: best-scoring copy leads; different titles stay separate', out[0].job.jobId === '1' && out[2].job.jobId === '4' && out[2].siblings.length === 0);
}

async function dbTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.log('SKIP  --db: DATABASE_URL must point at localhost'); failures++; return; }
  const { query, closePool } = await import('../lib/db.mjs');
  const { importJobByUrl } = await import('../lib/job-import.mjs');
  const cleanup = async () => {
    await query(`DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug IN ('motivosity','8westconsulting','londontech','lumapps'))`);
    await query(`DELETE FROM companies WHERE slug IN ('motivosity','8westconsulting','londontech','lumapps')`);
  };
  await cleanup();
  try {
    let r = await importJobByUrl('https://motivosity.breezy.hr/p/91f3de081402-ai-product-builder/apply');
    check('import: Breezy link → IMPORTED with a stored job id', r.ok && r.code === 'IMPORTED' && r.jobId, r);
    check('import: company registered for future scans (name from the board, priority 3)', r.company?.added === true && r.company.name === 'Motivosity', r.company);
    const { rows: co } = await query(`SELECT name, ats, slug, priority, active FROM companies WHERE ats='breezy' AND slug='motivosity'`);
    check('import: companies row', co[0]?.priority === 3 && co[0].active === true, co);
    const { rows: jobs } = await query(`SELECT j.title, j.ats, s.source FROM jobs j LEFT JOIN job_sources s ON s.job_id = j.id WHERE j.company_id = (SELECT id FROM companies WHERE slug='motivosity')`);
    check('import: the whole board is stored through the normal pipeline (jobs + job_sources)', jobs.length === 2 && jobs.every(j => j.ats === 'breezy' && j.source === 'breezy'), jobs);

    r = await importJobByUrl('https://motivosity.breezy.hr/p/fde3493b03a0-account-executive');
    check('import again: existing company reused (added:false)', r.ok && r.company.added === false && r.jobId, r);

    r = await importJobByUrl('https://8westconsulting.recruitee.com/o/senior-python-developer');
    check('import: EU job (Ireland) is now in coverage → IMPORTED', r.ok && r.code === 'IMPORTED' && r.jobId, r);

    r = await importJobByUrl('https://londontech.recruitee.com/o/backend-engineer');
    check('import: out-of-coverage job (UK) → OUTSIDE_COVERAGE, nothing stored for it', r.ok && r.code === 'OUTSIDE_COVERAGE' && r.jobId === null, r);

    r = await importJobByUrl('https://lumapps.teamtailor.com/jobs/9999999-gone');
    check('import: posting no longer on the board → NOT_FOUND_ON_BOARD, company still added', r.ok && r.code === 'NOT_FOUND_ON_BOARD' && r.company.added, r);

    r = await importJobByUrl('https://careers-peraton.icims.com/jobs/167302/x/job');
    check('import: unsupported ATS → ATS_NOT_SUPPORTED, nothing stored', !r.ok && r.code === 'ATS_NOT_SUPPORTED' && r.ats === 'icims', r);
    r = await importJobByUrl('https://nosuchco.recruitee.com/o/x');
    check('import: board that 404s → BOARD_UNREACHABLE', !r.ok && r.code === 'BOARD_UNREACHABLE', r);
    r = await importJobByUrl('not a url');
    check('import: garbage → INVALID_URL', r.code === 'INVALID_URL');
  } finally {
    await cleanup();
    await closePool();
  }
}

await providerTests();
const { detectAts } = await import('../lib/ats-detect.mjs');
const { canonicalJobUrl, findPastedJob } = await import('../lib/job-import.mjs');
detectTests(detectAts, canonicalJobUrl, findPastedJob);
const { groupOpenings } = await import('../matching/recommend.mjs');
groupingTests(groupOpenings);
if (process.argv.includes('--db')) await dbTests();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
