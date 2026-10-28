# User profile model and explainable recommendations

## Phase 1 audit — what existed before this phase

Three separate, disconnected profile representations existed:

1. **`user_profiles` / `user_target_roles` / `user_skills` / `user_profile_preferences`** — the intended authoritative model. Schema already matched this phase's target shape almost exactly (`user_profiles` had `current_title`, `total_experience_years`, `highest_education_level`, `current_city/state/country`, `work_authorization`, `needs_sponsorship`; `user_target_roles` had `canonical_role`/`role_family`/`priority`; `user_skills` had `skill_id`/`proficiency`/`years_experience`/`source`/`confidence`). **But `user_target_roles` and `user_skills` had zero API endpoints** — nothing read or wrote them before this phase. `user_profiles`/`user_profile_preferences` had a working GET/PUT via `/users/:userId/profile`, with no input validation or normalization.
2. **Legacy `user_preferences`** (plus `user_job_alerts`) — a flat, older table (`title_keywords`, `locations`, `remote_only`, `categories`, `exclude_companies`, `min_match_score`) still actively read/written by `matching/matcher.mjs` (called from `scanner/orchestrator.mjs` after every scan, and from `api/server.mjs`'s `/users/:userId/preferences` + `/users/:userId/match`), and by the *old* `matching/recommendations.mjs`, which merged it ad hoc with a partial read of the new profile tables.
3. **Frontend-only `localStorage` profile** (`jd_profile_v2` in `public/index.html`) — powers only the client-side profile-match badge on the port-3000 job board (title, skills array, level, expYears, workplace, jobtype, salaryMin, visa). Entirely disconnected from the backend; never synced to any of the above tables. Out of scope for this phase (Phase 27 explicitly rules out a frontend redesign) — it keeps working exactly as before.

**Duplicated field**: `user_profiles.needs_sponsorship` and `user_profile_preferences.require_sponsorship` represent the same fact. `user_profiles.needs_sponsorship` is authoritative (this phase's Phase 2 model places it there); `require_sponsorship` is now always written in sync by the profile API for any caller still reading it, and should be dropped once nothing does.

**Job fields the old recommender consumed**: a hand-rolled `SELECT` in the old `matching/recommendations.mjs` (`id, url, title, company, location, remote, ats, category, role_family, workplace_type, employment_type, posted_at, discovered, salary_min_annual, salary_max_annual, salary_currency`) — no skills, no education, no clearance, no citizenship, no sponsorship-aware filtering beyond a crude `sponsorship_status IN (...)` allowlist. Replaced by `matching/job-contract.mjs`'s `buildJobContracts()`, which is now the *only* place recommendation code reads job columns directly.

## Authoritative model (Phase 2)

`user_profiles`, `user_target_roles`, `user_skills` are unchanged from the audited schema. `user_profile_preferences` gained three columns to close gaps against Phase 3's hard-constraint list:

- `excluded_role_families TEXT[]`
- `allowed_countries TEXT[]`
- `salary_is_hard_constraint BOOLEAN` — governs whether `min_salary` gates eligibility (Phase 7) or only affects score (Phase 13); previously there was no way to express "salary is a hard floor" vs "salary is a nice-to-have."

## Hard constraints vs. soft preferences (Phase 3)

Enforced in `matching/eligibility.mjs` (hard — can reject) vs. `matching/*-score.mjs` (soft — only ranks):

| Hard (eligibility.mjs) | Soft (scoring modules) |
|---|---|
| `needsSponsorship` + job `NO_SPONSORSHIP` | preferred skills, preferred roles |
| citizenship requirement vs. `work_authorization` | preferred cities/states |
| `exclude_clearance_jobs` | remote/hybrid *preference* (not `remote_only`) |
| `preferred_employment_types` — **when non-empty, an allow-list**, not a soft nudge | salary preference (unless `salary_is_hard_constraint`) |
| `excluded_companies`, `excluded_role_families` | industry/company preference — **not implemented** (no data field to score against; see Known Limitations) |
| `allowed_countries` | experience (unless `max_experience_required` is set) |
| `max_experience_required` | education (unless `strictEducation` option is explicitly passed) |
| `salary_is_hard_constraint` + `min_salary` | |

**"Prefers remote" never means "reject hybrid."** `remote_only` (a distinct boolean, explicitly opted into) is the only thing that hard-gates workplace type; `preferred_workplace_types` only feeds `matching/location-score.mjs`.

## Profile normalization (Phase 4)

`lib/profile-normalize.mjs` reuses the *job-side* taxonomies rather than maintaining a second one:

- Roles: `lib/fingerprint.mjs`'s `classifyCategory()` + `lib/normalize.mjs`'s `CATEGORY_TO_ROLE_FAMILY` (now exported) — the same classifier a job's own title runs through.
- Skills: `lib/skills.mjs`'s `normalizeSkillName()` (Postgres→PostgreSQL, K8s→Kubernetes, JS→JavaScript, PySpark→Apache Spark — same alias table `data/skills-taxonomy.json` jobs use).
- Location: `lib/location.mjs`'s `matchState`/`matchCountry` (now exported) — the same state/country matchers job location strings use.
- Education: `lib/education.mjs`'s `EDUCATION_LEVELS` enum, validated against.

## API (Phase 5)

New: `GET/PUT /users/:userId/target-roles`, `GET/PUT /users/:userId/skills`, `GET/PUT /users/:userId/profile/preferences`, `GET /users/:userId/profile/completeness`. Extended: `PUT /users/:userId/profile` now validates `highest_education_level` against the canonical enum and normalizes `current_city/state/country` through the same location matcher jobs use.

**Legacy migration**: the spec's suggested `GET/PUT /users/:userId/preferences` path already existed, serving the *legacy* `user_preferences` table (still used by `matching/matcher.mjs`'s orchestrator-triggered flow) — reusing it for the new model would have silently broken that flow. Resolution: bare `/preferences` stays legacy; the new authoritative preferences live at `/profile/preferences` (also reachable as part of the full `/profile` payload). **Removal plan**: once nothing calls `matchUserFull`/`matching/matcher.mjs` (a product decision — that flow still populates `user_job_alerts` for whatever currently reads it), delete `user_preferences`, `matching/matcher.mjs`, and the bare `/preferences`/`/alerts`/`/match` routes together, since they're one cohesive legacy subsystem, not independent pieces.

## Eligibility engine (Phase 7/8)

`matching/eligibility.mjs`'s `evaluateEligibility(userProfile, userPreferences, job)` — see the file's own header comment for the full rule list and the UNKNOWN-never-hard-rejects policy, enforced per-rule (each check has an explicit "profile/job data is null → push to `unknowns`, don't reject" branch, not a blanket try/catch).

`clearanceEligible` is not yet a stored profile field (there's no UI/API surface asking the user "can you hold a clearance?" yet) — `matching/recommend.mjs` always passes `null` for it today, which correctly routes any clearance-required job into `unknowns` rather than silently rejecting or accepting it. Add a real column + question when the product wants to ask it.

## Scoring (Phase 9-17)

Seven independent, unit-tested modules (`role-score`, `skill-score`, `experience-score`, `location-score`, `salary-score`, `education-score`, `freshness-score`), combined by `final-score.mjs` with the spec's weights (30/25/10/10/10/10/5). Every component scorer returns a **neutral, non-zero** score when its input is missing (documented in `final-score.mjs`'s header) — this is *why* the combiner needs no special-case redistribution logic for missing data: neutrality is already baked in one level down.

**Known limitation on role scoring**: `jobs.canonical_role` is currently just a copy of `role_family` (set by `lib/normalize.mjs`) — there is no finer-grained job-side role classifier yet (e.g. distinguishing `DATA_ENGINEER` from `ML_ENGINEER` within `DATA_SCIENCE`). `matching/role-score.mjs` implements the full EXACT/SAME_FAMILY/RELATED/NONE contract and a real relationship map for when finer roles exist, but at today's data granularity most real matches land in `SAME_FAMILY`, not `EXACT`. This upgrades automatically if job-side canonical roles ever gain finer granularity — no scoring-code change needed.

## Candidate generation (Phase 18)

`matching/recommend.mjs`'s funnel: `READY`+`active` → exclude `SKIP`/`HIDE`/`APPLY` interactions → SQL-expressible hard filters (sponsorship, employment-type allow-list, excluded companies/role-families, clearance exclusion, max-experience ceiling, hard salary floor, `remote_only`, role-family ± adjacent-family narrowing) → bounded pool (2000) ordered by recency → full-fidelity `evaluateEligibility()` per candidate (catches citizenship/country/multi-location nuance SQL can't express cleanly) → score → sort → paginate.

## Interaction exclusions (Phase 20)

Already correct in the existing `user_job_interactions` write path; `matching/recommend.mjs`'s candidate query excludes `SKIP`/`HIDE`/`APPLY`, never `VIEW`/`SAVE` — per spec.

## Known limitations

- No "industry preference" or "preferred companies" scoring — no job-side `industry` field and no `preferred_companies` profile column exist; adding either is straightforward but out of this phase's scope.
- `clearanceEligible` has no stored profile field yet (see above).
- Role scoring operates at `role_family` granularity for the vast majority of real jobs (see above).
- The frontend's `localStorage` profile-match badge remains a separate, unconnected system by design (Phase 27).
