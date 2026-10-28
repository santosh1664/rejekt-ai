/**
 * harvester/commoncrawl.mjs
 *
 * Auto-discovers companies using Common Crawl's CDX Index.
 *
 * Strategy:
 *   For each ATS, query the CDX API for pages matching the ATS's known URL
 *   pattern (e.g. *.greenhouse.io/jobs, *.lever.co/*, etc.), extract company
 *   slugs, validate they have a live job board, and upsert into the companies
 *   table.
 *
 * CDX API:
 *   https://index.commoncrawl.org/{INDEX}-index?url=URL&matchType=domain|prefix&output=json&fl=url
 *   Results are newline-delimited JSON (one object per line), not a JSON array.
 *
 * Common Crawl indexes are released monthly.  Set COMMON_CRAWL_INDEX in .env
 * to pin a specific index name (e.g. CC-MAIN-2024-22); otherwise the latest
 * index is looked up from collinfo.json at runtime.
 *
 * Usage:
 *   node harvester/commoncrawl.mjs [--ats greenhouse] [--dry-run] [--verbose]
 *
 * Estimated yield per ATS (based on crawl coverage):
 *   Greenhouse    ~8 000 slugs
 *   Lever         ~3 000 slugs
 *   Ashby         ~1 000 slugs
 *   Workable      ~2 000 slugs
 *   SmartRecrs    ~1 500 slugs
 *   BambooHR      ~2 500 slugs
 *   Workday       ~500  slugs (harder — unique per-tenant domains)
 */

import { fetchJSON, fetchText, headStatus, sleep } from '../lib/http.mjs';
import { query }                                   from '../lib/db.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────

// Fallback only — used if COMMON_CRAWL_INDEX isn't set and collinfo.json can't be reached.
const FALLBACK_INDEX = 'CC-MAIN-2024-22';
const CDX_BASE       = 'https://index.commoncrawl.org';
const CDX_LIMIT      = 10_000;    // max results per CDX page
const VALIDATE_CONCURRENCY = 20;  // parallel HEAD requests during validation

let _latestIndexCache = null;

/**
 * Resolve which Common Crawl index to query: explicit override > COMMON_CRAWL_INDEX
 * env var > latest index from collinfo.json (cached per-process) > hardcoded fallback.
 * Common Crawl publishes a new index roughly monthly, so a hardcoded default goes
 * stale — this keeps the harvester working without manual updates.
 */
async function resolveIndex(indexOverride) {
  if (indexOverride) return indexOverride;
  if (process.env.COMMON_CRAWL_INDEX) return process.env.COMMON_CRAWL_INDEX;
  if (_latestIndexCache) return _latestIndexCache;

  try {
    const collections = await fetchJSON(`${CDX_BASE}/collinfo.json`, { timeoutMs: 15_000 });
    _latestIndexCache = collections[0].id;
  } catch {
    _latestIndexCache = FALLBACK_INDEX;
  }
  return _latestIndexCache;
}

// ─── ATS patterns ────────────────────────────────────────────────────────────
// url pattern → extract slug + build validation URL

const ATS_PATTERNS = [
  {
    ats:     'greenhouse',
    // boards.greenhouse.io/SLUG  or  job-boards.greenhouse.io/SLUG
    // Two fixed hosts — query each as a prefix rather than matchType=domain
    // over the whole apex, which would also sweep in greenhouse.io's own
    // marketing/blog pages and is too large a scan to complete before CDX
    // times out.
    pattern: '*.greenhouse.io/*/jobs*',
    queries: [
      { url: 'boards.greenhouse.io/',     matchType: 'prefix' },
      { url: 'job-boards.greenhouse.io/', matchType: 'prefix' },
    ],
    // CDX url column looks like: https://boards.greenhouse.io/stripe/jobs/…
    extract: (url) => {
      const m = url.match(/greenhouse\.io\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://boards.greenhouse.io/${slug}`,
  },
  {
    ats:     'lever',
    // jobs.lever.co/SLUG
    pattern: 'jobs.lever.co/*/*',
    queries: [{ url: 'jobs.lever.co/', matchType: 'prefix' }],
    extract: (url) => {
      const m = url.match(/jobs\.lever\.co\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://jobs.lever.co/${slug}`,
  },
  {
    ats:     'ashby',
    // jobs.ashbyhq.com/SLUG
    pattern: 'jobs.ashbyhq.com/*/*',
    queries: [{ url: 'jobs.ashbyhq.com/', matchType: 'prefix' }],
    extract: (url) => {
      const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  },
  {
    ats:     'workable',
    // apply.workable.com/SLUG or SLUG.workable.com
    pattern: 'apply.workable.com/*/j/*',
    queries: [{ url: 'apply.workable.com/', matchType: 'prefix' }],
    extract: (url) => {
      const m = url.match(/apply\.workable\.com\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://apply.workable.com/${slug}`,
  },
  {
    ats:     'smartrecruiters',
    // jobs.smartrecruiters.com/SLUG/...
    pattern: 'jobs.smartrecruiters.com/*/*',
    queries: [{ url: 'jobs.smartrecruiters.com/', matchType: 'prefix' }],
    extract: (url) => {
      const m = url.match(/smartrecruiters\.com\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://jobs.smartrecruiters.com/${slug}`,
  },
  {
    ats:     'bamboohr',
    // SLUG.bamboohr.com/careers — slug is a per-company subdomain, so unlike
    // the others there's no fixed host to prefix-match; domain-wide is required.
    pattern: '*.bamboohr.com/careers*',
    queries: [{ url: 'bamboohr.com', matchType: 'domain' }],
    extract: (url) => {
      const m = url.match(/\/\/([^.]+)\.bamboohr\.com/);
      return m ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://${slug}.bamboohr.com/careers/list`,
  },
  // ── Added 2026-10-23 (docs/job-sourcing.md) ──────────────────────────────
  {
    ats:     'recruitee',
    pattern: '*.recruitee.com/o/*',
    queries: [{ url: 'recruitee.com', matchType: 'domain' }],
    extract: (url) => {
      const m = url.match(/\/\/([a-z0-9-]+)\.recruitee\.com/i);
      return m && !['www', 'app', 'api', 'blog', 'support'].includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://${slug}.recruitee.com/api/offers`,
  },
  {
    ats:     'breezy',
    pattern: '*.breezy.hr/p/*',
    queries: [{ url: 'breezy.hr', matchType: 'domain' }],
    extract: (url) => {
      const m = url.match(/\/\/([a-z0-9-]+)\.breezy\.hr/i);
      return m && !['www', 'app', 'api', 'help', 'marketplace'].includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://${slug}.breezy.hr/json`,
  },
  {
    ats:     'pinpoint',
    pattern: '*.pinpointhq.com/*/postings/*',
    queries: [{ url: 'pinpointhq.com', matchType: 'domain' }],
    extract: (url) => {
      const m = url.match(/\/\/([a-z0-9-]+)\.pinpointhq\.com/i);
      return m && !['www', 'app', 'api', 'help'].includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://${slug}.pinpointhq.com/postings.json`,
  },
  {
    ats:     'rippling',
    pattern: 'ats.rippling.com/*/jobs*',
    queries: [{ url: 'ats.rippling.com/', matchType: 'prefix' }],
    extract: (url) => {
      const m = url.match(/ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
      return m && m[1] !== 'api' ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`,
  },
  {
    ats:     'teamtailor',
    pattern: '*.teamtailor.com/jobs/*',
    queries: [{ url: 'teamtailor.com', matchType: 'domain' }],
    extract: (url) => {
      const m = url.match(/\/\/([a-z0-9-]+)\.teamtailor\.com/i);
      return m && !['www', 'app', 'api', 'support', 'career'].includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
    },
    validate: (slug) => `https://${slug}.teamtailor.com/jobs.rss`,
  },
  // Workday and Oracle Cloud: very fragmented (each company has its own
  // tenant host + site id). CDX patterns are too broad; add them via manual
  // seed, or let users add them by pasting a job link (POST /jobs/import).
  // Workday now has its own harvester: harvester/workday.mjs (npm run harvest:workday).
];

// ─── CDX fetch ────────────────────────────────────────────────────────────────

/**
 * Query CDX for all URLs matching a domain or path prefix.
 *
 * @param {string} cdxUrl     — bare host, or host+path prefix ending in '/'
 * @param {string} matchType  — 'domain' | 'prefix' | 'exact'
 * @param {string} [index]    — CC index name
 * @returns {Promise<string[]>}  — raw URL strings
 */
async function fetchCdxUrls(cdxUrl, matchType, index) {
  // Index server is named "{id}-index" (not "{id}/cdx"); results come back as
  // newline-delimited JSON, one object per line, not a JSON array.
  const endpoint = `${CDX_BASE}/${index}-index` +
    `?url=${encodeURIComponent(cdxUrl)}` +
    `&matchType=${matchType}` +
    `&output=json&fl=url&collapse=urlkey`;

  let allUrls = [];
  let page    = 0;

  while (true) {
    const pageUrl = `${endpoint}&page=${page}&limit=${CDX_LIMIT}`;
    let text;
    try {
      text = await fetchText(pageUrl, {
        headers:   { 'User-Agent': 'rejekt-ai/1.0 (commoncrawl-harvester)' },
        timeoutMs: 60_000,
      });
    } catch (err) {
      // CDX returns 404 when no (more) results — treat as empty
      if (err.message?.includes('404')) break;
      throw err;
    }

    const lines = text.split('\n').filter(Boolean);
    if (lines.length === 0) break;

    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.url) allUrls.push(row.url);
    }

    if (lines.length < CDX_LIMIT) break;  // last page
    page += 1;
    await sleep(500);
  }

  return allUrls;
}

// ─── Validation pool ─────────────────────────────────────────────────────────

/**
 * Validate that a URL responds with 2xx/3xx (not 404/4xx).
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isAlive(url) {
  try {
    const status = await headStatus(url, {
      headers:   { 'User-Agent': 'rejekt-ai/1.0 (harvester)' },
      timeoutMs: 10_000,
    });
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

/**
 * Validate slugs in parallel with a concurrency cap.
 *
 * @param {Array<{slug, validateUrl}>} candidates
 * @param {number} concurrency
 * @param {boolean} verbose
 * @returns {Promise<Set<string>>}  — valid slugs
 */
async function validateSlugs(candidates, concurrency = VALIDATE_CONCURRENCY, verbose = false) {
  const valid   = new Set();
  let   idx     = 0;
  let   active  = 0;

  await new Promise((resolve) => {
    function pump() {
      while (active < concurrency && idx < candidates.length) {
        const { slug, validateUrl } = candidates[idx++];
        active++;
        isAlive(validateUrl).then((ok) => {
          if (ok) valid.add(slug);
          if (verbose && ok) console.error(`    ✓ ${slug} → ${validateUrl}`);
          active--;
          pump();
          if (active === 0 && idx >= candidates.length) resolve();
        });
      }
      if (candidates.length === 0) resolve();
    }
    pump();
  });

  return valid;
}

// ─── DB upsert ───────────────────────────────────────────────────────────────

/**
 * Upsert a batch of discovered companies into the companies table.
 *
 * @param {Array<{name, ats, slug}>} companies
 * @param {boolean} dryRun
 * @returns {Promise<{inserted: number, existing: number}>}
 */
async function upsertCompanies(companies, dryRun = false) {
  if (dryRun) return { inserted: companies.length, existing: 0 };

  let inserted = 0;
  let existing = 0;

  for (const c of companies) {
    try {
      const { rows } = await query(
        `INSERT INTO companies (name, ats, slug, discovered)
              VALUES ($1, $2, $3, NOW())
         ON CONFLICT (ats, slug) DO NOTHING
         RETURNING id`,
        [c.name, c.ats, c.slug]
      );
      if (rows.length > 0) inserted++;
      else existing++;
    } catch (err) {
      console.error(`  ✗ upsert failed [${c.ats}/${c.slug}]: ${err.message}`);
    }
  }

  return { inserted, existing };
}

// ─── Main harvest ─────────────────────────────────────────────────────────────

/**
 * Run the Common Crawl harvest for one or all ATS platforms.
 *
 * @param {object} opts
 * @param {string}  [opts.ats]      — filter to one ATS
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.verbose]
 * @param {boolean} [opts.skipValidation]  — skip HEAD checks (faster, less accurate)
 * @param {string}  [opts.index]    — CC index name override
 */
export async function harvest(opts = {}) {
  const index    = await resolveIndex(opts.index);
  const patterns = ATS_PATTERNS.filter(p => !opts.ats || p.ats === opts.ats.toLowerCase());

  if (patterns.length === 0) {
    console.error(`No ATS patterns matched for: ${opts.ats}`);
    return;
  }

  console.error(`\n🌐  Common Crawl harvest  (index: ${index})`);
  console.error(`   ATS targets: ${patterns.map(p => p.ats).join(', ')}`);
  console.error(`   Mode: ${opts.dryRun ? 'DRY RUN' : 'LIVE'}  |  validation: ${opts.skipValidation ? 'SKIP' : 'ON'}\n`);

  const grandTotal = { slugsFound: 0, slugsValid: 0, inserted: 0, existing: 0 };

  for (const { ats, pattern, queries, extract, validate } of patterns) {
    console.error(`\n📡  [${ats}]  CDX pattern: ${pattern}`);

    // 1. Pull URLs from CDX (one ATS may need multiple host queries)
    let urls = [];
    let failed = false;
    for (const { url: cdxUrl, matchType } of queries) {
      try {
        urls.push(...await fetchCdxUrls(cdxUrl, matchType, index));
      } catch (err) {
        console.error(`  ✗ CDX fetch failed [${cdxUrl}]: ${err.message}`);
        failed = true;
      }
    }
    if (failed && urls.length === 0) continue;
    console.error(`   CDX urls fetched : ${urls.length.toLocaleString()}`);

    // 2. Extract slugs (de-dup)
    const slugSet = new Set();
    for (const url of urls) {
      const slug = extract(url);
      if (slug && slug.length > 0 && slug.length < 80) slugSet.add(slug);
    }
    console.error(`   Unique slugs     : ${slugSet.size.toLocaleString()}`);
    grandTotal.slugsFound += slugSet.size;

    // 3. Validate (optional)
    let validSlugs;
    if (opts.skipValidation) {
      validSlugs = slugSet;
    } else {
      const candidates = [...slugSet].map(slug => ({ slug, validateUrl: validate(slug) }));
      console.error(`   Validating ${candidates.length.toLocaleString()} slugs (concurrency ${VALIDATE_CONCURRENCY})…`);
      validSlugs = await validateSlugs(candidates, VALIDATE_CONCURRENCY, opts.verbose);
      console.error(`   Live boards      : ${validSlugs.size.toLocaleString()}`);
    }
    grandTotal.slugsValid += validSlugs.size;

    // 4. Build company rows  (name = Title Case of slug, overridden later by admin)
    const companies = [...validSlugs].map(slug => ({
      name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      ats,
      slug,
    }));

    // 5. Upsert
    const { inserted, existing } = await upsertCompanies(companies, opts.dryRun);
    console.error(`   Inserted new     : ${inserted.toLocaleString()}`);
    console.error(`   Already known    : ${existing.toLocaleString()}`);
    grandTotal.inserted += inserted;
    grandTotal.existing += existing;
  }

  // Summary
  console.error(`\n${'─'.repeat(56)}`);
  console.error(`✅  Harvest complete${opts.dryRun ? '  [DRY RUN]' : ''}`);
  console.error(`${'─'.repeat(56)}`);
  console.error(`   Slugs found      : ${grandTotal.slugsFound.toLocaleString()}`);
  console.error(`   Live boards      : ${grandTotal.slugsValid.toLocaleString()}`);
  console.error(`   New companies    : ${grandTotal.inserted.toLocaleString()}`);
  console.error(`   Already in DB    : ${grandTotal.existing.toLocaleString()}`);
  console.error(`${'─'.repeat(56)}\n`);

  return grandTotal;
}
