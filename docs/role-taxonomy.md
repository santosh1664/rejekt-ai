# Role taxonomy

Fine-grained canonical-role and specialization taxonomy, built to give
`matching/role-score.mjs` real discrimination within a `role_family` bucket.
Implemented across `lib/role-taxonomy.mjs` (data), `lib/role-classifier.mjs`
(role-v2, the deterministic title classifier), and `scripts/backfill-roles.mjs`
(corpus backfill + `job_classifications` audit trail).

## Why this exists

Before this phase, `jobs.canonical_role` was always either NULL
(`role_family='OTHER'`) or an exact copy of `jobs.role_family` — verified
live against the corpus: 89,759/105,719 READY jobs exactly equal, 0
disagreements. `role_specialization` was 100% NULL. This meant
`matching/role-score.mjs` could never discriminate, say, a Backend Engineer
from a Frontend Engineer within `role_family=SOFTWARE_ENGINEERING` — the
single largest driver of ranking false positives identified in the prior
phase (`RELATED_ROLE_TOO_GENEROUS`, 66/71 of top-10 false positives).

## Role families (unchanged)

`role_family` stays exactly as it was — the broad bucket, populated at
ingestion time by `lib/fingerprint.mjs`'s `classifyCategory()`. This phase
never touches `role_family` assignment.

**Known pre-existing limitation** (out of scope for this phase):
`classifyCategory`'s patterns for SOFTWARE_ENGINEERING (`quality engineer`,
`test engineer`, bare `engineer`/`developer`) are broad enough to sweep in
hardware/manufacturing/aerospace titles ("Supplier Quality Engineer",
"Electrical Test Engineer", "Flight Test Engineer") and even unrelated jobs
("Cookie Crew", "Bike Delivery Courier") under some data conditions. The
role-v2 classifier is deliberately conservative in the presence of this
noise (see "Ambiguity handling" below) — it never compounds the error by
forcing a wrong finer classification, but it can't fix the underlying
`role_family` assignment either.

## Canonical roles (finer, within a family)

Full depth is only built for the three families with real corpus volume and
benchmark coverage, verified via a live corpus audit before writing any
code: **SOFTWARE_ENGINEERING** (20,156 READY jobs), **DATA_SCIENCE** (2,944),
**DEVOPS_SRE** (6,207). Every other family (SALES, PRODUCT, FINANCE, ...)
keeps `canonical_role === role_family`, matching pre-phase behavior — adding
canonical-role depth there had no corpus evidence behind it ("do not make it
excessively granular... curate only meaningful role distinctions").

| Family | Canonical roles |
|---|---|
| SOFTWARE_ENGINEERING | SOFTWARE_ENGINEER (generic), BACKEND_ENGINEER, FRONTEND_ENGINEER, FULL_STACK_ENGINEER, MOBILE_ENGINEER, EMBEDDED_ENGINEER, GAME_ENGINEER, SOFTWARE_ARCHITECT, QA_ENGINEER, QA_AUTOMATION_ENGINEER, SDET |
| DATA_SCIENCE | DATA_ENGINEER, ETL_ENGINEER, ANALYTICS_ENGINEER, DATA_PLATFORM_ENGINEER, DATA_SCIENTIST, DATA_ANALYST, ML_ENGINEER, AI_ENGINEER, MLOPS_ENGINEER, ML_PLATFORM_ENGINEER, RESEARCH_SCIENTIST |
| DEVOPS_SRE | DEVOPS_ENGINEER, SITE_RELIABILITY_ENGINEER, PLATFORM_ENGINEER, CLOUD_ENGINEER, INFRASTRUCTURE_ENGINEER, NETWORK_ENGINEER, SECURITY_ENGINEER, CLOUD_SECURITY_ENGINEER, APPLICATION_SECURITY_ENGINEER, RELEASE_ENGINEER |

`SOFTWARE_ENGINEER` is the only role flagged `generic: true` in
`lib/role-taxonomy.mjs`'s `CANONICAL_ROLES` map — it's the within-family
catch-all `lib/role-classifier.mjs` assigns to a bare "Software
Engineer"/"Engineer II"/unspecific title. **This flag matters**: two jobs
both landing on a generic role are NOT a genuine specialization match, and
`matching/role-score.mjs` treats a generic canonical role the same as a
raw-family fallback — never eligible for `EXACT_CANONICAL`. (This exact gap
caused a real regression during development — see `docs/ranking-experiments.md`'s
RANK-010 entry — before the flag was added.)

The classifier is **flat across families**, not gated by the job's own
`role_family`: a title like "Software Engineer, Machine Learning" is
evaluated against ALL canonical-role patterns regardless of which
`role_family` the job happens to carry, because `classifyCategory`
sometimes disagrees with where a title "should" land (that exact title lands
in `role_family=SOFTWARE_ENGINEERING`, not `DATA_SCIENCE`, because
`classifyCategory`'s software-engineering pattern matches bare "machine
learning" before the stricter data-science phrase can). `matching/role-score.mjs`
never trusts a mismatched family from this — it always uses the job's own
`role_family` column for family-level comparisons; `canonical_role` only
drives the finer EXACT/adjacency tiers.

## Specializations

A closed, small set per canonical role (`lib/role-taxonomy.mjs`'s
`specializations` array), e.g. `BACKEND_ENGINEER`: `JAVA, PYTHON, NODE,
DOTNET, GO, RUBY`; `ML_ENGINEER`: `LLM, NLP, COMPUTER_VISION,
RECOMMENDATION_SYSTEMS, MLOPS`. Detected from the title first
(`lib/role-classifier.mjs`'s `SPECIALIZATION_PATTERNS`), falling back to a
regex scan of the job's own required/preferred skills only when the title
gave no signal — never guessed from company/description context. UNKNOWN
(`null`) is the expected, common outcome — never forced.

In scoring, specialization is a small **bonus, never a penalty**: an
`EXACT_CANONICAL` match starts at 95 and only reaches 100 when the user's
skill list also covers the job's specialization; a specialization mismatch
or unknown specialization leaves the score at 95, it never drops lower.
(`user_target_roles` has no stored specialization column — the user's
specialization preference is inferred from their existing skill list rather
than adding a new column, since that's already-available profile data.)

## Title-pattern rules and priority

`lib/role-classifier.mjs`'s `RULES` array is checked top-to-bottom, first
match wins — ordered most-specific-phrase-first (spec's own priority
scheme): explicit acronyms/compound phrases ("SDET", "site reliability
engineer", "machine learning engineer") → broader-but-still-specific
phrases ("backend"/"frontend"/"full stack"/"embedded") → QA/test patterns
(guarded against a real corpus collision, below) → the generic
software-engineer catch-all last. A non-contiguous fallback exists for a
few common orderings ("Software Engineer, Machine Learning" still resolves
to `ML_ENGINEER`, just at a lower confidence band than the exact phrase).

Title normalization lowercases, strips punctuation, and collapses
whitespace before matching (no stemming/fuzzy matching — deliberately
simple and deterministic, no embeddings).

## Ambiguity handling

A title with no specific-enough pattern match falls back to the broader
canonical role — `SOFTWARE_ENGINEER` (the generic bucket) for a bare
"Software Engineer"/"Engineer II"/"Developer", or all the way to the raw
`role_family` value (confidence 0.3) when literally nothing matches at all
(e.g. "Cookie Crew" — a real corpus title landing in
`role_family=SOFTWARE_ENGINEERING` via the pre-existing bug described
above). The classifier never guesses finer than the evidence supports.

## Confidence policy

| Band | Score | When |
|---|---|---|
| High | 0.85–0.9 | Explicit, unambiguous phrase or acronym present |
| Medium-high | 0.7–0.8 | Compound/non-contiguous phrase still clearly evidenced |
| Medium | 0.55 | Generic title, no specific pattern (the `SOFTWARE_ENGINEER` catch-all) |
| Low | 0.3 | No pattern matched at all — falls back to `role_family` |

Confidence and the matched evidence phrase are persisted to `job_classifications`
(`field_name IN ('canonical_role', 'role_specialization')`,
`classifier_version='role-v2'`) for every job, alongside the pre-existing
classifiers for other fields (`experience-v1`, `salary-v4`, etc. — this
table already existed with exactly this shape before this phase; no schema
change was needed).

## Adjacency map

`lib/role-taxonomy.mjs`'s `ROLE_ADJACENCY` — explicit pairwise weights
within a family, centralized in one place (never scattered pairwise checks
through `matching/role-score.mjs`). Four tiers: very close (0.92), close
(0.78), related (0.55), weak (0.32) — initial values, tuned against the
dev benchmark split (`docs/ranking-experiments.md`'s RANK-010 entry), not
chosen a priori. Cross-family adjacency is unchanged from the prior phase
(`matching/role-score.mjs`'s `FAMILY_ADJACENCY`, family-level only).

## Role-score integration

`matching/role-score.mjs`'s tier order (spec's preferred ordering — never
let title similarity override real canonical-role evidence):

1. **EXACT_CANONICAL** — same canonical role on both sides, neither a raw
   family copy nor the generic catch-all. Base 95, +5 (to 100) with a
   specialization bonus.
2. **RELATED_CANONICAL** — explicit `ROLE_ADJACENCY` entry between two
   genuinely-finer canonical roles in the same family.
3. **SAME_FAMILY_GENERIC** — same family, no finer signal on one or both
   sides. Title-token Jaccard similarity (carried over from the prior
   phase) is the tie-breaker here ONLY — never a primary signal anymore.
4. **DIFFERENT_FAMILY_RELATED** — cross-family `FAMILY_ADJACENCY`.
5. **UNRELATED** — flat low score.

A mild priority discount (1.0 / 0.9 / 0.8 by the user's target-role
priority) applies to whichever tier's score is reported, unchanged from the
prior phase.

## How to safely add a role

1. Check real corpus evidence first — query `normalized_title` frequency
   within the target `role_family` before adding anything (see the audit
   queries in `docs/ranking-experiments.md`'s RANK-010 entry for the
   pattern). Don't add a role with no real titles behind it.
2. Add the canonical role to `lib/role-taxonomy.mjs`'s `CANONICAL_ROLES`
   with its family and (optional) specialization list. Mark it `generic:
   true` only if it's meant to be a within-family catch-all — a generic
   role never participates in `EXACT_CANONICAL`.
3. Add adjacency entries to `ROLE_ADJACENCY` for its real relationships to
   existing roles in the same family (both directions aren't required —
   `roleAdjacency()` checks either order).
4. Add one or more ordered rules to `lib/role-classifier.mjs`'s `RULES`
   array, placed by specificity (a more specific phrase earlier than a
   broader one it could be confused with — see spec Step 6/7's collision
   guidance). Add a guard against any known false-positive collision the
   same way `HARDWARE_TEST_EXCLUSION_RE` guards QA_ENGINEER.
5. Add tests to `scripts/test-role-classifier.mjs` for the new pattern and
   any collision it could plausibly cause.
6. Bump `CLASSIFIER_VERSION` (e.g. `role-v3`) whenever `RULES` changes in a
   way that could reclassify existing jobs — `scripts/backfill-roles.mjs`'s
   idempotency is keyed on this string (`job_classifications`' unique
   `(job_id, field_name, classifier_version)` index), so an unbumped
   version means already-classified jobs are silently skipped on the next
   backfill run even if the rules changed underneath them. (This bit us
   once during this phase's own development — see
   `docs/ranking-experiments.md`.)
7. Re-run `node --env-file=.env.local scripts/backfill-roles.mjs --force`
   to reclassify the full corpus, then re-run the benchmark
   (`node --env-file=.env.local scripts/evaluate-recommendations.mjs --set dev --dump ...`
   followed by `node scripts/rank-diagnostics.mjs ...`) before trusting the
   change.
