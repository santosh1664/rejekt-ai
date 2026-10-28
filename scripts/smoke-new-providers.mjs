/**
 * scripts/smoke-new-providers.mjs
 *
 * Live check of the six providers added 2026-10-23 against the public
 * boards they were verified on (docs/job-sourcing.md). Read-only: fetches
 * and prints counts + one sample job per board. Writes nothing.
 *
 *   node scripts/smoke-new-providers.mjs            # all six
 *   node scripts/smoke-new-providers.mjs rippling   # one provider
 *
 * Boards change over time — a 404 on one board usually means the company
 * moved ATS, not that the provider broke. Swap in another live board.
 */
const BOARDS = [
  { ats: 'recruitee',   company: { name: '8 West Consulting', slug: '8westconsulting' } },
  { ats: 'breezy',      company: { name: 'Motivosity', slug: 'motivosity' } },
  { ats: 'pinpoint',    company: { name: 'Collab', slug: 'collab' } },
  { ats: 'rippling',    company: { name: 'Aalo Atomics', slug: 'aalo-atomics' } },
  { ats: 'teamtailor',  company: { name: 'LumApps', slug: 'lumapps' } },
  { ats: 'oraclecloud', company: { name: 'JPMorgan Chase', slug: 'jpmc.fa.oraclecloud.com/CX_1002', meta: { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1002' } } },
];

const only = process.argv[2];
process.env.ORACLE_MAX_PAGES ??= '2';     // keep the smoke run quick
process.env.RIPPLING_MAX_DETAILS ??= '5';
let failed = 0;
for (const { ats, company } of BOARDS.filter(b => !only || b.ats === only)) {
  const started = Date.now();
  try {
    const { fetchAll } = await import(`../providers/${ats}.mjs`);
    const jobs = await fetchAll(company, {});
    const s = jobs[0];
    const dated = jobs.filter(j => j.posted_at).length;
    console.log(`✓ ${ats.padEnd(12)} ${String(jobs.length).padStart(4)} jobs  ${dated} dated  ${Date.now() - started}ms`);
    if (s) console.log(`    e.g. "${s.title}" · ${s.location || '—'} · ${s.posted_at || 'no date'} · ${s.url}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${ats.padEnd(12)} ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
