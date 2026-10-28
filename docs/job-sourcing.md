# Job sourcing: how Tsenta pulls jobs, and what this project added

Added 2026-10-23.

- **Code:** `providers/{recruitee,breezy,pinpoint,rippling,teamtailor,oraclecloud}.mjs`,
  `lib/ats-detect.mjs`, `lib/job-import.mjs`, `groupOpenings()` in
  `matching/recommend.mjs`, `POST /jobs/import`
- **Tests:** `npm run test:job-sourcing` (fixtures in `fixtures/sourcing/`)
- **Live check:** `npm run smoke:providers`

## 1. How Tsenta sources jobs (evidence)

Tsenta's backend isn't visible. The evidence comes from four places, all
gathered read-only on 2026-10-23:

- 174 unique jobs from the user's Tsenta feed (4 pages through Tsenta's own
  API)
- Tsenta's public dashboard bundle
- Tsenta's landing page
- Direct calls to the ATS APIs the jobs link to

### Every job carries a `source`

| `source` | Share of 174 | ATS types seen | Distinguishing traits |
|---|---|---|---|
| `ats-boards` | 70 (40%) | workday 16, ashby 15, greenhouse 14, smartrecruiters 7, oraclecloud 4, lever 4, dover 2, workable 2, zohorecruit, brassring, recruitee, paylocity, ultipro, teamtailor | Tsenta's **own crawler** of public ATS board APIs. No skill tags; years of experience parsed (54/70); salary from structured ATS fields (50/70); 17 dates at exact midnight (date-only sources like Oracle). |
| `jobo` | 72 (41%) | ashby 15, workday 12, greenhouse 8, workable 7, oraclecloud, eightfold, successfactors, icims, zohorecruit, recruitee, breezy, rippling, dayforce, gem, careerplug, gusto, csod… | A **paid aggregator feed** (Jobo Connect: "Bulk fetch jobs from 57 ATS platforms", cursor-paged, `posted_after` for incremental sync). Arrives pre-enriched: skill tags 72/72, seniority 72/72. Some jobs' "datePosted" is weeks in the future (e.g. 2026-11-30): Tsenta maps the feed's `valid_through` / expiry into the posted date. |
| `scoutify` | 25 (14%) | workday, smartrecruiters, greenhouse, ashby, lever, jobvite, rippling | Another aggregator. |
| `hiring.cafe` | 6 | ashby, workable | Another aggregator. |
| `jobright.ai` | 1 | workday | Another aggregator. |

Every job, whatever its source, links to the **employer's own ATS page**.
The aggregators are used for discovery, not as the place you apply.

### The `ats-boards` crawler reads public board APIs directly

Posted times match the ATS's own timestamps to the second:

- Recruitee: `published_at` "2026-10-23 13:27:46 UTC" equals Tsenta's
  `datePosted` 2026-10-23T13:27:46Z.
- Breezy: `published_date` 2026-06-26T16:23:09 equals Tsenta's `datePosted`
  for the same job.

The landing page claims "watches 50,000+ career pages across Workday,
Greenhouse, Lever, Ashby and 30+ more ATSes". The login page claims
"Match you with 2M+ jobs".

### Dedupe and grouping

Each job has `canonicalRoleKey` = `"company|lowercased title"` and a
`siblings[]` list: same role, other URLs or cities. Examples:

- ServiceNow "Sr Software Engineer" has 3 SmartRecruiters reqs.
- Luxer One has the same Zoho req under two domains.

The drawer shows these as "N openings".

### Paste-a-link

The dashboard bundle's `ats` chunk is a host-pattern table of about 45 ATSes,
each marked `supported: true/false`. The UI copy includes:

- "Search by title or keyword, or paste a job link"
- "Checking link…"
- `ATS_NOT_SUPPORTED`: "…don't recognize that job site yet. Try the link to
  the application page itself."

### Job boards

There are connectors for Indeed and Naukri ("Connect job boards like Indeed
and Naukri to your feed"). These are user-account connections, not crawling.

## 2. This project before 2026-10-23

The project already had Tsenta's `ats-boards` architecture:

- per-ATS providers that read public board APIs
- a `companies` table of boards
- the Common Crawl harvester for discovering boards
- a sharded scanner with per-ATS concurrency pools
- a freshness pass that closes jobs missing from 2 scans
- raw payloads in `raw_job_postings` and `job_sources`

It covered 7 ATSes: greenhouse, ashby, lever, workday, bamboohr, workable and
smartrecruiters.

## 3. What was added

### Six ATS providers

Each was verified against a live board in the browser, because the build
sandbox has no outbound access. Real responses are saved as fixtures.

| ATS | Endpoint (no auth) | Verified on | Dates | Notes |
|---|---|---|---|---|
| recruitee | `GET https://{slug}.recruitee.com/api/offers` | 8westconsulting | `published_at` (exact) | description + requirements, country code |
| breezy | `GET https://{slug}.breezy.hr/json` | motivosity | `published_date` (exact) | no description in the list |
| pinpoint | `GET https://{slug}.pinpointhq.com/postings.json` | collab | none exposed | description sections, structured compensation |
| rippling | `GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` + `/jobs/{uuid}` | aalo-atomics (83 jobs) | `createdOn` from detail | details fetched 4 at a time, capped by `RIPPLING_MAX_DETAILS` (300) |
| teamtailor | `GET https://{slug}.teamtailor.com/jobs.rss` | lumapps (22 jobs) | `pubDate` | RSS parsed without dependencies; link may be a custom careers domain |
| oraclecloud | `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?…finder=findReqs;siteNumber={site},limit=25,offset=N,sortBy=POSTING_DATES_DESC` | jpmc.fa.oraclecloud.com / CX_1002 (7,242 jobs) | `PostedDate` (date only) | newest first, capped by `ORACLE_MAX_PAGES` (40 pages = 1,000 jobs); short description only |

Wiring:

- registered in `scanner/worker.mjs` `PROVIDERS` and in `lib/pool.mjs`
  `ATS_CONCURRENCY` (Rippling 3 and Oracle 2, because they make more calls
  per board)
- Common Crawl discovery patterns added for recruitee, breezy, pinpoint,
  rippling and teamtailor
- Oracle, like Workday, is per-tenant, so it's added by seed or by pasted link

Providers that know a structured country pass it as `job.countryCode`, and
`classifyJobCountry` trusts that over location text. `classifyJobCountry`
returns a region — `US`, `CA`, `EU`, `AU`, `OTHER` or `UNKNOWN` — and the
scanner keeps a job when `isJobInCoverage()` is true: the region is in
`ALLOWED_REGIONS` (US + Canada + EU + Australia by default, overridable with
the `JOB_REGIONS` env var, e.g. `JOB_REGIONS="US,CA"`) or `UNKNOWN` (no
confident signal, e.g. "Remote job"). Only confidently out-of-coverage jobs
(`OTHER`) are dropped. The EU set is the 27 member states; the UK, Norway,
Switzerland and Iceland are `OTHER`.

To add an Oracle tenant by hand:

```sql
INSERT INTO companies (name, ats, slug, meta)
VALUES ('JPMorgan Chase', 'oraclecloud', 'jpmc.fa.oraclecloud.com/CX_1002',
        '{"host":"jpmc.fa.oraclecloud.com","site":"CX_1002"}');
```

### Add a job by link

`POST /jobs/import {url}`. The dashboard calls it when a link is pasted into
the search box or into the "Add a job by link" card.

1. `detectAts(url)` reads the ATS, the slug or meta, and the job ID from the
   URL (13 supported ATSes, about 28 recognized-but-unsupported hosts).
2. It fetches the board once and upserts the company with `priority 3`. **Every
   pasted link grows the scan list**, and that board stays fresh on every later
   scan.
3. It runs the normal worker pipeline on the already-fetched jobs (classify,
   enrich, `raw_job_postings`, `job_sources`).
4. It returns the stored job ID, which the UI opens in the drawer.

Result codes:

| Code | HTTP | Meaning |
|---|---|---|
| `IMPORTED` | 200 | The job was stored. |
| `NOT_FOUND_ON_BOARD` | 200 | The company was added, but the posting has closed. |
| `OUTSIDE_COVERAGE` | 200 | The job's region (e.g. UK, India) is outside coverage (US, Canada, EU, Australia). |
| `ATS_NOT_SUPPORTED` | 422 | The site is recognized but can't be scanned yet. |
| `INVALID_URL` | 400 | Not a valid http(s) link. |
| `BOARD_UNREACHABLE` | 502 | The job board couldn't be fetched. |
| `SCAN_FAILED` | 502 | The board was fetched but the scan failed. |

`GET /jobs/import/check?url=` reports what a link is without fetching it.

### Openings grouping

`groupOpenings()` collapses feed results with the same company and
normalized title into one card, keeping the best-scoring copy and listing
the rest in `siblings`. The fingerprint DISTINCT ON in candidate selection
only catches byte-identical postings.

UI: a "+N more" chip on the card, and an "N openings" table in the drawer.

## 4. Not added, and why

- **Aggregator feeds (Jobo, Scoutify, hiring.cafe, jobright.ai).** These are
  roughly 60% of Tsenta's sample. They're commercial data contracts, and
  Jobo's API docs aren't publicly readable (docs.jobo.world disallows
  fetching). If you sign up, a feed fits as one more source that writes
  `raw_job_postings` + `job_sources` with `source = '<feed>'` and resolves to
  the ATS URL. Map `date_posted` (not `valid_through`) to `posted_at` to avoid
  Tsenta's future-date bug.
- **iCIMS, Taleo, SuccessFactors, Jobvite, Zoho Recruit, Dover, Gem,
  Paylocity, UKG/UltiPro, Eightfold.** These have no verified auth-free JSON
  board API. They're recognized by `detectAts` so users get a clear message.
- **Out-of-coverage jobs.** Tsenta's feed is global. This scanner keeps jobs
  in `ALLOWED_REGIONS` (US, Canada, EU, Australia by default) plus any job it
  can't confidently place, and drops the rest. Change coverage with the
  `JOB_REGIONS` env var; run `node db/filter-us.mjs --dry-run` to see what the
  current setting would keep or delete among stored jobs.
- **Scan cadence.** Tsenta serves `ats-boards` jobs minutes after they're
  posted. This project scans every 6h by default (`scripts/run-scan.sh`).
  Raising frequency for `priority <= 3` companies (including pasted ones)
  would close most of that gap.
