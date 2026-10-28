# Job Platform Implementation Status

**Last updated:** 2026-10-02

## Summary

The platform has been upgraded incrementally from a legacy job table and keyword search flow toward a structured job-discovery and recommendation platform. The existing `jobs` table, job IDs, scanner, and frontend compatibility have been preserved.

The database foundation, canonical enrichment, structured search, profile API foundation, and recommendation API foundation are implemented. Beyond that original foundation, the project has since gone through several full calibration/repair phases (role-family classifier repair, fine-grained canonical-role taxonomy, structured ranking calibration across multiple rounds, a from-scratch Benchmark-v2/v2.1 construction with eligibility-vs-quality separation, a full-text search performance fix, and a role-taxonomy consistency audit+repair) — see "Phase History" below for what each one covered. Historical raw/source reconciliation, complete skill-extraction quality work, vector embeddings, and frontend integration remain unfinished; vector embeddings specifically have been repeatedly assessed as **not yet justified** (see "pgvector readiness" below), not merely "not done."

## Phase History (post-foundation)

Each phase below is complete and reported on in detail in `docs/ranking-experiments.md` / `docs/role-taxonomy.md` / `docs/role-consistency.md` / `docs/benchmark-v2-methodology.md` / `docs/benchmark-v2.1-methodology.md`. Summarized here in chronological order.

1. **Structured ranking quality optimization** — initial tuning pass over `matching/final-score.mjs`'s weighted scoring (role/skills/experience/location/freshness/salary), with a regression-test suite (`scripts/test-ranking-regressions.mjs`) added to lock in each fix.
2. **Fine-grained canonical-role classification** — introduced `lib/role-taxonomy.mjs` (`CANONICAL_ROLES`, `ROLE_ADJACENCY`) and `lib/role-classifier.mjs` (`classifyRole()`), giving jobs a specific `canonical_role`/`role_specialization` within their broader `role_family` (e.g. `BACKEND_ENGINEER` within `SOFTWARE_ENGINEERING`) instead of `canonical_role` always copying `role_family`.
3. **Upstream role-family classifier repair** — hardened `lib/fingerprint.mjs`'s `classifyCategory()` against cross-discipline keyword collisions (quality/test/automation/systems/embedded/reliability terms that used to default to software engineering regardless of actual discipline).
4. **Post-classification ranking calibration** — recalibrated `matching/final-score.mjs`'s dampening logic (`ROLE_DAMPEN`, experience-based score cap) against the corrected classification data from phase 3.
5. **Recommendation benchmark v2** — built `fixtures/benchmark-v2/` (9 profiles, stratified sampling across 9 buckets A–I, independent of the ranking model being evaluated) to replace a legacy 15-job-per-profile fixture that was mathematically incapable of moving P@10/bad-match once reranked.
6. **Benchmark-v2 ranking calibration** — two targeted, evidence-driven scoring fixes (EXACT_CANONICAL required-skill floor, SAME_FAMILY_GENERIC conditional dampening) measured against benchmark-v2, with full dev+holdout before/after numbers and zero regression on protected profiles.
7. **`/jobs?q=...` search performance fix** — replaced an unindexed runtime `to_tsvector(...)` expression (root cause of a 30s statement-timeout/500 error) with a persisted, trigger-maintained, weighted `search_vector` column + GIN index + bounded ranked-search candidate set + capped approximate count for broad terms. Measured: P50 193ms / P95 2.5s (down from a hard 500 on common terms). Recommendation ranking untouched.
8. **Benchmark-v2.1 cleanup + final structured ranking calibration** — fixed benchmark-v2's one design flaw (quality buckets could contain jobs that failed the profile's own hard-eligibility constraints, contaminating quality metrics with eligibility-engine behavior) by pre-filtering every quality candidate through the real `evaluateEligibility()` at build time; also found and fixed a benchmark-sampling gap (`active=TRUE` was never required, so some "relevant" jobs were already-stale postings — fixed, candidate recall restored to 100%). Two ranking fixes (RANK-021: exact canonical-role match must win over a role_family disagreement; RANK-022: conditional dampening for `DIFFERENT_FAMILY_RELATED` matches with weak skill overlap), both Pareto-improving with zero protected-profile regression.
9. **Role taxonomy consistency audit + repair** — traced and fixed the root cause of the canonical_role/role_family mismatches phase 8's ranking fix had to defensively guard around: `classifyCategory()` misrouted bare "ML Engineer"/"AI Engineer" titles to `SOFTWARE_ENGINEERING` instead of `DATA_SCIENCE`, plus two of `role-classifier.mjs`'s own rules over-trusted ambiguous bare phrases ("Quality Engineer", "Embedded Engineer") with no hardware/software context check, plus a taxonomy data error (`RESEARCH_SCIENTIST` declared under the wrong family). Added `validateRoleClassification()` + confidence-based family reconciliation at ingestion time, backfilled the full corpus (108,265 jobs scanned, 1,725 repaired, 0 failures), and drove live-corpus invalid combinations to **zero**. Benchmark re-run on the repaired data showed the fix's traceable effects were uniformly positive (previously-overscored mismatched jobs correctly demoted); remaining metric noise was isolated to independent live-corpus drift (re-scraping updating skills/salary/employment-type on this continuously-scraped board), not the repair itself.

## Completed Work

### Baseline and documentation

Created baseline documentation:

- `docs/current-schema.md`
- `docs/current-search-flow.md`
- `docs/baseline-metrics.md`
- `docs/jobs-api-phase1.md`
- `.github/instructions/job-pipeline-architecture.instructions.md`

The baseline recorded the original job volume, completeness, duplicate candidates, search behavior, and representative query/API timings.

### Database schema

The main schema is now additive and reproducible through `db/schema.sql`.

Added tables:

- `raw_job_postings`
- `job_sources`
- `job_classifications`
- `skills`
- `skill_aliases`
- `job_skills`
- `job_locations`
- `job_processing_events`
- `user_profiles`
- `user_target_roles`
- `user_skills`
- `user_profile_preferences`
- `user_job_interactions`
- `applications`
- `job_embeddings`

Added canonical columns to `jobs`, including:

- `display_title`
- `normalized_title`
- `canonical_role`
- `role_family`
- `role_specialization`
- `description_clean`
- `status`
- `workplace_type`
- `employment_type`
- `min_exp_years`
- `max_exp_years`
- `salary_min_annual`
- `salary_max_annual`
- `salary_currency`
- `sponsorship_status`
- `description_hash`
- `raw_job_id`

The schema migration was successfully applied to the live database with `npm run migrate`.

### Raw ingestion

New scanner runs now preserve provider payloads before classification.

Implemented in:

- `scanner/worker.mjs`
- `lib/db.mjs`
- `lib/fingerprint.mjs`

The new path stores:

- Provider source
- Source URL
- External job ID when available
- Raw title, company, location, description, and payload
- Content hash
- Processing status
- Source-to-canonical job links

### Canonical normalization

Implemented deterministic normalization in `lib/normalize.mjs`:

- HTML description cleanup
- Entity decoding
- Title normalization
- `Sr.` to `Senior`
- `Jr.` to `Junior`
- `SWE` and `SDE` expansion
- Role-family mapping
- Workplace classification
- Basic city/state/country parsing
- Employment type extraction
- Experience extraction
- Salary extraction
- Sponsorship classification
- Clearance detection

Unknown values remain unknown instead of being invented.

### Canonical backfill

Created:

- `scripts/backfill-canonical.mjs`
- `npm run backfill:canonical`

The canonical backfill completed for the full existing corpus at the time of execution:

```text
102,585 jobs processed
```

The live database now contains more jobs because scanner activity continued during implementation.

### Classification audit

Added `job_classifications` to preserve:

- Field name
- Predicted value
- Confidence
- Classifier version
- Evidence
- Timestamp

New and changed jobs record category and role-family evidence during processing.

### Skills foundation

Implemented:

- Canonical skills table
- Skill aliases
- Job-to-skill relationships
- Alias normalization
- Required/preferred/mentioned importance values
- Deterministic skill extraction

Relevant files:

- `lib/skills.mjs`
- `lib/skill-extract.mjs`
- `scripts/backfill-skills.mjs`

The historical skill backfill was optimized to use bounded batch writes and supports resuming with `SKILLS_START_ID`.

### Structured locations

Implemented `job_locations` persistence for normalized city/state/country data. New and backfilled jobs can receive structured location records.

### Processing audit

Added `job_processing_events` and scanner writes normalization completion events with version metadata.

### Jobs API

Fixed and verified the `/jobs` endpoint.

Supported filters include:

- `q`
- `category`
- `role_family`
- `workplace_type`
- `employment_type`
- `sponsorship_status`
- `experience_max`
- `salary_min`
- `state`
- `skills`
- `ats`
- `company_id`
- `remote`

Supported sort modes include:

- Default/newest
- `oldest`
- `salary`
- `experience`

The endpoint keeps legacy response fields and adds canonical fields.

Added server-side diagnostics that record PostgreSQL query failures without exposing internal SQL details to clients.

### API regression tests

Created:

- `scripts/test-jobs-api.mjs`
- `npm run test:jobs-api`

The suite covers 16 cases:

- No-filter requests
- Search
- Every structured filter
- Every sort mode
- Combined filters
- Skills filtering

All 16 checks pass.

### Profile and recommendation APIs

Added profile routes:

- `GET /users/:userId/profile`
- `POST /users/:userId/profile`
- `PUT /users/:userId/profile`

Added recommendation route:

- `GET /users/:userId/recommendations`

Added interaction route:

- `POST /users/:userId/jobs/:jobId/interactions`

The current recommendation engine is deterministic and explainable. It uses title/category/location/freshness signals, excludes skipped/hidden/applied jobs, and applies profile constraints where available.

### Validation

Repeated validation has passed for:

- JavaScript syntax checks
- Editor diagnostics
- Schema dry-run checks
- Live schema migration
- Canonical normalization checks
- Skill normalization checks
- Jobs API regression tests
- Jobs API smoke tests
- Profile endpoint smoke tests
- Recommendation endpoint smoke tests

## Live Database Coverage

The latest measured coverage was approximately:

- READY jobs: `108,265` (full corpus scan, role-consistency backfill, 2026-10-01)
- Role-taxonomy consistency: canonical_role/role_family invalid combinations: `0` (was 2,005 / 3.03% before the repair phase)
- `search_vector` (full-text search column): populated for all READY jobs, GIN-indexed
- PostgreSQL vector extension: still not installed — see "pgvector readiness" below

Earlier raw/source/skills coverage numbers (jobs, raw-linked jobs, raw postings, source links, structured locations, skill rows) were not re-measured in the phases above, since none of them touched that part of the pipeline — treat the 104,650-era figures as stale rather than current. Counts change continuously while the scanner is running.

## pgvector readiness

Reassessed at the end of each ranking-related phase; consistently **NOT_READY_FOR_PGVECTOR** through the role-consistency repair phase (most recent assessment). The remaining top-10 false positives are still structured-rule-space issues — seniority-band mismatches, generic-role (`SAME_FAMILY_GENERIC`) matching, required-skill-gap interactions, and role-family-adjacency boundary cases — not semantic/synonym/long-tail-phrasing gaps that embeddings would actually address. Revisit only once remaining failures shift toward that latter category.

## Remaining Work

### Historical raw/source reconciliation

Not complete for the entire corpus.

The resumable command is:

```bash
npm run reconcile:raw
```

It should be run during a quiet scanner window. Earlier bulk attempts encountered deadlocks because the scanner was simultaneously writing to the same tables.

### Skill backfill completion

The backfill reached most of the corpus but was stopped after database contention with the active scanner and autovacuum.

Resume with:

```bash
DB_STATEMENT_TIMEOUT=120000 SKILLS_START_ID=77500 npm run backfill:skills
```

The command is resumable and should be run without overlapping scanner maintenance if possible.

### Embeddings

The `job_embeddings` table exists, but embeddings are not implemented because the connected PostgreSQL database does not have the `vector` extension.

Pending:

- Install or provision `pgvector`
- Select embedding model and dimensions
- Generate structured job embeddings
- Generate profile embeddings
- Add vector candidate retrieval
- Compare vector ranking against the rule-based baseline

### Full processing state machine

The `status` column and processing-event table exist, but the complete asynchronous state machine is not implemented.

Pending states and behavior:

```text
RAW -> NORMALIZING -> ENRICHING -> READY
FAILED -> retry
READY -> EXPIRED or ARCHIVED
```

### Structured skill quality

The current extractor is deterministic and conservative. It does not yet provide production-grade section-aware extraction for all descriptions.

Pending:

- Better required/preferred section detection
- More complete skill vocabulary
- Skill confidence evaluation
- Skill extraction quality metrics
- User-skill integration in ranking

### Recommendation quality

**Largely superseded by the Phase History above** — required/preferred skill scoring, experience/salary/location scoring, a stratified benchmark (`fixtures/benchmark-v2.1/`, 9 profiles, dev+holdout split, quality-vs-eligibility separated), and ranking quality metrics (P@5/P@10/Recall@10/NDCG/MRR/bad-match-rate, normalized/theoretical-max precision, candidate recall) are all implemented and actively used for calibration. Current benchmark-v2.1 numbers (post role-consistency repair): dev P@10=0.722, NDCG@10=0.965, bad-match@10=0.044; holdout P@10=0.333, NDCG@10=0.967, bad-match@10=0.289 (holdout's lower P@10 is a labeled-pool-size ceiling, not a ranking defect — see `docs/ranking-experiments.md`).

Still pending:

- A human-reviewed (as opposed to structured-metadata-labeled) recommendation test set.
- Further reduction of the residual false-positive categories (seniority-band mismatches, generic-role matching, required-skill-gap interactions) if a future phase is directed to pursue it — see each phase's own "Next recommended step."

### Frontend integration

The frontend still primarily uses legacy API contracts.

Pending:

- Structured filter controls
- Skill display and filtering
- Salary and sponsorship display
- Profile editing UI
- Recommendation feed
- Match explanation UI
- View/save/skip/apply interaction wiring

## Explicitly Not Completed

The following should not be described as complete yet:

- Full historical raw migration
- Full historical source-link migration
- Complete skill backfill verification / section-aware extraction quality
- Vector embeddings
- Vector search
- Asynchronous enrichment queue
- Frontend migration

Recommendation benchmark evaluation and profile-based ranking **are** now implemented and actively maintained (Phase History above) — removed from this list; only the human-reviewed test set and residual false-positive reduction remain open under "Recommendation quality."

## Useful Commands

```bash
npm run migrate
npm run test:jobs-api
npm run backfill:canonical
npm run reconcile:raw
npm run backfill:skills
npm run api
npm run scan

# Ranking / benchmark / role-consistency (added across later phases — no package.json script aliases yet, run directly)
node --env-file=.env.local scripts/build-benchmark-v2.1.mjs
node --env-file=.env.local scripts/evaluate-recommendations-v2.1.mjs --set dev --dump evaluation/dev.json
node --env-file=.env.local scripts/evaluate-recommendations-v2.1.mjs --set holdout --dump evaluation/holdout.json
node scripts/rank-diagnostics-v2.1.mjs evaluation/dev.json
node scripts/test-ranking-regressions.mjs
node --env-file=.env.local scripts/audit-role-consistency.mjs
node --env-file=.env.local scripts/backfill-role-consistency.mjs --dry-run
node scripts/test-role-consistency.mjs
```

## Current Assessment

The backend has moved well beyond a basic job-listing implementation: structured recommendation ranking, a fine-grained role taxonomy with enforced canonical_role/role_family consistency, a stratified dev/holdout benchmark with eligibility-vs-quality separation, and fast full-text search are all implemented, measured, and under active calibration. The remaining work is concentrated in: historical raw/source backfill completion, skill-extraction quality (section-aware required/preferred detection), a human-reviewed recommendation test set, frontend adoption of the new contracts, and — only once the remaining ranking false positives shift from structured-rule issues toward genuine semantic/long-tail gaps — vector search.
