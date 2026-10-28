# Feed keyword search

Added 2026-10-23. Code: `matching/keyword-search.mjs`, `matching/saved-search.mjs`,
`matching/recommend.mjs`, `api/server.mjs`. Tests: `npm run test:keyword-search`.

This feature is modeled on how search works in Tsenta's job feed. The first half
of this doc is the evidence for how Tsenta behaves. The second half is how this
project implements the same ideas on top of its own structured matching.

## 1. How Tsenta's search works (evidence)

Tsenta's source isn't available, so this is black-box evidence from two places:

- **Contract**: the descriptions Tsenta publishes for its own search tools
  (`get-job-recommendations`, `inspect-served-jobs`, `set-keyword-search`,
  `assess-feed-relevance`, `get-embedding-summary`).
- **Live**: calls made against a real Tsenta account on 2026-10-23.

Where the contract and the live results disagree, that's noted.

| # | Behavior | Source | What we saw |
|---|----------|--------|-------------|
| E1 | Search is a layer on top of a personalized, ranked feed, not a separate search page. | Contract + live | Every result carries a `matchScore` 0–100. Results come back "best match first" under the user's saved feed filters (date, experience level, workplace, location, role category, employment type, degree, visa, max years). |
| E2 | The base ranking is similarity to a profile "embedding text". | Live (`get-embedding-summary`) | The profile is reduced to one text blob built from resume bullets ("Architected and delivered AI agent workflows…"), last enriched 2026-09-04. Feed scores are similarity against that text. |
| E3 | `include` terms are OR-ed; `exclude` terms hide a job. Terms are `\|`-separated. | Contract + live | The saved keyword on the account was 8 OR-ed terms: `software engineer\|ai software engineer\|full stack software engineer\|…\|ai/ml engineer`. |
| E4 | Three scopes: `title` (default), `title_description`, `description`. | Contract | "`title_description` also scans descriptions: only for a skill that lives there (Terraform, LangChain)." |
| E5 | Title matching is semantic, not literal. | Contract + live | The contract says title scope "matches titles by meaning too ('GenAI engineer' finds ML roles)". Live, the 8-term title keyword served **Engineering Manager (73)**, **Data Acquisition Associate (57)**, **Field Applications Engineer (53)** and **Data Scientist – Measurement (51)**. None of those titles contain any of the 8 terms literally. So the matching is semantic, and also quite loose. |
| E6 | A title search covers every job, not just jobs near the profile. | Contract | "Title scope searches every job, not only the ones nearest the profile, so it finds a role the profile is not centered on ('react' for a Java profile)." The separate `all` scope "matches only among the jobs nearest the profile". |
| E7 | Description scope finds skills that never appear in titles. | Live | `LangChain` with `title_description` (30d) returned **Software Testing Lead** (LangChain only in the extracted `skillTags`) and **Senior AI Engineer – Databricks / GenAI**. |
| E8 | Excluding in description scope over-hides. | Contract | "Excludes then hide every job whose description mentions the term ('senior' is in most descriptions)." |
| E9 | Keyword-matched scores are rebased upward and aren't comparable to unkeyworded ones. | Contract | "Title-matched scores run higher than unkeyworded ones; never compare the two." |
| E10 | A keyword is previewed against the real feed and refused if it returns nothing. | Contract + live | `set-keyword-search` "REFUSES one that returns no jobs". Live, previewing `GenAI engineer` under the saved filters returned 0 jobs, `zeroIsAuthoritative: true`, and the message "that keyword returns NO jobs right now; do not set it". |
| E11 | Empty results explain why they're empty. | Contract + live | Possible reasons: `NO_PROFILE`, `NO_EMBEDDINGS`, `FILTERS_NARROW`, `NO_MATCHING_JOBS` (+ `activeFilters`), `PAGINATION_EXCEEDED`, `TEMPORARILY_UNAVAILABLE`. Live, a nonsense keyword returned `NO_MATCHING_JOBS` with `activeFilters: ["search"]`. |
| E12 | Applied or skipped jobs are left out. Duplicate postings are grouped. | Live | The coverage line says "jobs already applied to or skipped left out". Jobs carry `canonicalRoleKey` = `company\|title` plus `siblings`. |
| E13 | Feed relevance check with "what if" alternatives. | Live (`assess-feed-relevance`) | "Strong" means 65+. Current feed: 1 strong job (top 73, median 48). Counterfactual "drop the max-years cap": 20 strong (top 78). Each counterfactual comes with a ready-to-apply filter patch. *(Not built here; see Next steps.)* |

What we learn from E5: semantic title matching is what makes searches like
"GenAI engineer" useful. But Tsenta's version is loose enough that a
software-engineer keyword serves an Engineering Manager job at 73. This project
makes semantic matching deliberately tighter (see 2b).

## 2. How this project implements it

### a. Where it plugs in

Keyword search is a layer on the existing recommendation funnel in
`matching/recommend.mjs`, same as E1. Hard filters, eligibility, the
`computeFinalScore` weights and fingerprint de-duplication are all unchanged:

```
active/READY jobs
  -> drop SKIP/HIDE/APPLY interactions                      (E12)
  -> profile hard filters (sponsorship, remote, salary, …)
  -> role-family narrowing      ← SKIPPED when a title-scope include is active (E6)
  -> keyword include/exclude    ← new
  -> DISTINCT ON fingerprint, newest 2000
  -> evaluateEligibility → computeFinalScore
  -> keyword match classification + score rebase          ← new (E9)
  -> sort, paginate, zeroResultReason when empty          ← new (E11)
```

### b. Matching per scope (E3, E4, E5, E7)

| Scope | Include matches when… |
|-------|-----------------------|
| `title` | `normalized_title` / `title` contains a term **or** `canonical_role` is in the term's semantic expansion |
| `title_description` | the `title` rules above, **or** `search_vector @@ websearch_to_tsquery(term)`, **or** the job has the term as an extracted skill (`job_skills`) |
| `description` | the description-weight (`C`) part of `search_vector` matches, **or** an extracted skill matches |

**Semantic title expansion** runs through the existing taxonomy instead of
embeddings. The project has repeatedly decided embeddings aren't justified yet;
see IMPLEMENTATION-STATUS.

1. The term goes through `normalizeRoleInput()` → `classifyRole()`. A few
   search-phrasing rewrites run first ("GenAI/LLM/agentic" → "ai",
   "developer" → "engineer", "ML" → "machine learning"), and stack hints act
   as a fallback (Java/Python/Node → BACKEND, React/Angular/Vue → FRONTEND).
2. It expands only to `ROLE_ADJACENCY` pairs at **VERY_CLOSE (≥0.9)**. So
   "GenAI engineer" → AI_ENGINEER + ML_ENGINEER, and "SDET" →
   QA_AUTOMATION_ENGINEER. CLOSE pairs are left out on purpose. Otherwise
   "backend" would pull in every full-stack and generic SWE posting: the same
   looseness as E5.
3. Generic roles (SOFTWARE_ENGINEER) never expand, because they would match a
   whole family. A literal "software engineer" title match handles those.

**Excludes** are literal only and never semantically expanded. In
non-title scopes they also hit the description, and the response then includes
a `searchWarnings` entry about over-hiding (E8).

### c. Scoring (E9)

Each keyword-matched job gets a `keywordMatch` with a type and strength:

- `TITLE`: 1.0
- `SEMANTIC_TITLE`: 0.85 × adjacency weight
- `DESCRIPTION`: 0.4

`rebaseScore()` then recovers 35% × strength of the remaining headroom
(`100 − base`).

- For title-intent matches, the base ignores `final-score.mjs`'s **role cap**.
  The user is saying "this is the role I want right now".
- The **experience cap is kept**. Searching "engineering manager" doesn't make a
  3-year profile a fit for a role that needs 10 years.

Rebased jobs carry `scoreRebased: true` and `baseMatchScore`, so clients never
compare them against unkeyworded scores.

### d. Saved search and validation (E3, E10)

- `user_keyword_searches` holds one saved search per user.
- `PUT /users/:id/search` previews against the user's real feed first and
  returns **422** when the result would be empty:
  - `NO_MATCHING_JOBS` means the keyword matches nothing at all; change the keyword.
  - `FILTERS_NARROW` + `activeFilters` means it matches, but other filters remove
    everything; loosen a filter.
- Request params (`?search=`) are a **preview**: they override the saved search
  for that request and change nothing.
- `?use_saved_search=false` shows the unkeyworded feed.

### e. Empty results (E11)

`zeroResultReason` is one of:

- `NO_PROFILE`
- `NO_MATCHING_JOBS`: the keyword alone matches no READY job. Checked with a
  `LIMIT 1` probe.
- `FILTERS_NARROW`
- `NOT_ELIGIBLE`: candidates existed but all failed `evaluateEligibility`.

`appliedFilters` holds human-readable lines like Tsenta's coverage line, and
`activeFilters` holds the machine-readable keys.

## 3. API

```
GET /users/:userId/recommendations
      ?search=react|frontend          include terms (OR)
      &exclude_search=senior|staff    exclude terms
      &search_scope=title             title | title_description | description
      &use_saved_search=false         ignore the saved search
      (+ existing limit, cursor, posted_within_days, strict)

GET    /users/:userId/search          saved search, or {active:false}
PUT    /users/:userId/search          {include:[…]|"a|b", exclude:[…], scope}
                                      200 {saved, keywordSearch, preview}
                                      422 {refused, zeroResultReason, activeFilters, message}
                                      empty include+exclude clears it
DELETE /users/:userId/search
```

New response fields on recommendations:

- top level: `keywordSearch`, `activeFilters`, `appliedFilters`,
  `searchWarnings`, `zeroResultReason`
- per job: `keywordMatch`, `baseMatchScore`, `scoreRebased`

## 4. Performance

Measured on a local PostgreSQL 16 loaded with 120,000 synthetic READY jobs,
using the real `db/schema.sql` (median of 4 runs, full `generateRecommendations`
including scoring):

| Query | Median |
|-------|--------|
| no keyword (baseline) | 263 ms |
| title `react\|backend` | 346 ms |
| title `GenAI engineer` | 260 ms |
| exclude `senior` | 347 ms |
| title_description `LangChain` (~1.2k matches) | 713 ms |
| description `LangChain` | 816 ms |
| no-match keyword (fast zero-result path) | 49 ms |

Production timings on RDS will differ, so re-check with `EXPLAIN ANALYZE` after
migrating. The migration adds `idx_jobs_normalized_title_trgm` for the
normalized-title `LIKE ANY` path.

## 5. Next steps

- **Feed relevance counterfactuals (E13).** Run the recommendation pipeline
  with one hard filter relaxed at a time, and return the strong-match (≥65)
  count plus a ready-to-apply preferences patch.
- **UI.** `public/index.html` still talks to `server.mjs`'s `/api/jobs`. It
  needs an exclude box and a "saved search" chip wired to the endpoints above.
