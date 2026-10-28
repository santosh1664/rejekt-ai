# Current Search Flow Baseline

Captured: 2026-09-26

## API entry point

The current search endpoint is `GET /jobs` in `api/server.mjs`.

Supported query parameters:

- `q`: PostgreSQL English full-text query over title and company.
- `category`: exact category filter.
- `ats`: exact ATS filter.
- `company_id`: exact company filter.
- `remote=true|false`: boolean remote filter.
- `page` and `limit`: offset pagination, capped at 200 rows per page.

## Query behavior

1. Start with `j.active = TRUE`.
2. Add optional parameterized filters.
3. Run a separate `COUNT(*)` query for the total.
4. Select a fixed list of job fields.
5. Sort by `discovered DESC`.
6. Apply `LIMIT` and `OFFSET`.

The detail endpoint `GET /jobs/:id` returns the full job row, including raw JSON, joined to the company name.

## Matching behavior

The matcher reads active jobs from `jobs` and uses `category`, title keywords, location, and `remote` to score user preferences. Category contributes 25 points to the current score. Alerts are stored in `user_job_alerts` with one row per user/job pair.

## Current query plans

Warm-cache `EXPLAIN (ANALYZE, BUFFERS)` results:

- Active jobs ordered by discovery, limit 25: 0.194 ms execution time.
- Active software-engineering jobs ordered by discovery, limit 25: 0.416 ms execution time.

Both plans use `idx_jobs_discovered` and filter `active` and, where applicable, `category` during the index scan.

## Current API timing

Measured locally on 2026-09-26:

- `GET /health`: 0.501 seconds total.
- `GET /jobs?limit=25`: 0.253 seconds total.

These timings include application and database connection overhead and are not equivalent to PostgreSQL execution time.

## Limitations to address later

- Search does not use a canonical `search_vector` with weighted title, role, skills, summary, and clean description fields.
- Search does not support structured role, location, skill, salary, experience, sponsorship, employment, or workplace filters.
- Offset pagination will become less efficient at deep pages; cursor pagination should be added after the canonical ordering is defined.
- Search and personalized recommendations share the same underlying endpoint conceptually but should become separate workflows.
- List responses do not expose structured locations, skills, salary, or match explanations.
