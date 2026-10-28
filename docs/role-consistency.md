# Role taxonomy consistency

## Audit results (role-consistency repair phase)

Live corpus audit, `scripts/audit-role-consistency.mjs` (READY/active jobs):

| | Before repair | After repair |
|---|---|---|
| Total | 66,261 | 66,268 |
| CONSISTENT | 37,764 (56.99%) | 38,304 (57.80%) |
| CANONICAL_ROLE_FAMILY_MISMATCH | 2,005 (3.03%) | **0 (0.00%)** |
| SPECIALIZATION_CANONICAL_MISMATCH | 0 | 0 |
| UNKNOWN_CANONICAL | 25,024 (37.77%) | 25,584 (38.61%) |
| LEGACY_FAMILY_FALLBACK | 1,468 (2.22%) | 2,380 (3.59%) |

`scripts/backfill-role-consistency.mjs --force` (full corpus, `status='READY'`
regardless of `active`): scanned 108,265, repaired 1,725 (1.6%), 0 failures.
Top causes: bare "engineer"/"developer" within an adjacent-but-wrong family
(no longer forced to SOFTWARE_ENGINEER), AI_ENGINEER/ML_ENGINEER titles
previously misrouted to SOFTWARE_ENGINEERING (the headline bug), and the
RESEARCH_SCIENTIST taxonomy correction. Verified on live data: 300 most-
recently-ingested jobs (by id, spanning up to the time of this check) show
zero invalid combinations — the ingestion path itself is fixed, not just
historical backfill.


Audits and enforces that every job's `role_family` / `canonical_role` /
`role_specialization` triple is internally valid against the authoritative
taxonomy in `lib/role-taxonomy.mjs`. Companion to `docs/role-taxonomy.md`
(the taxonomy's own design doc) — this document covers consistency
*enforcement*, not the taxonomy's content.

## The authoritative mapping

`lib/role-taxonomy.mjs`'s `CANONICAL_ROLES` object is the single source of
truth: `CANONICAL_ROLES[canonicalRole] = { family, specializations: [...] }`.
Every canonical role belongs to exactly one `role_family`; every
specialization belongs to exactly one canonical role's declared set.
Nothing else in the codebase duplicates this mapping — every validation
helper and every classifier reads it directly.

Two helpers built on it (also in `lib/role-taxonomy.mjs`):

- **`validateRoleClassification({ roleFamily, canonicalRole, roleSpecialization })`**
  → `{ valid: boolean, errors: string[] }`. The one function anything that
  writes these three columns should call before persisting. A KNOWN
  canonical role (a `CANONICAL_ROLES` key) must match its declared family
  and specialization set; `canonicalRole === roleFamily` (not-deepened
  state) and `canonicalRole === null` (UNKNOWN) are always valid.
- **`classifyRow({ role_family, canonical_role, role_specialization })`** →
  one of 7 audit buckets (below), built directly on
  `validateRoleClassification` — used only for reporting, never for
  persistence decisions.

## Classifier ordering (unchanged, already correct)

```
normalize title
  -> classifyCategory(title)              [lib/fingerprint.mjs]    -> role_family
  -> classifyRole({title, roleFamily})     [lib/role-classifier.mjs] -> canonical_role, role_specialization (may CORRECT role_family)
  -> validateRoleClassification(...)       [lib/role-taxonomy.mjs]   -> safety-net gate
  -> persist                               [lib/db.mjs batchUpsertJobs]
```

`lib/normalize.mjs`'s `normalizeJob()` is the single ingestion-path
function that wires this together; `scanner/worker.mjs` calls it for every
new/changed job via `smartClassify()` (`lib/ml-classify.mjs`, which only
delegates to `classifyCategory()` — the frozen bias-inheriting ML model
from an earlier phase is disabled). `scripts/backfill-role-consistency.mjs`
re-runs the identical pipeline for existing rows.

## Root cause of the historical mismatch class

`lib/role-classifier.mjs`'s `classifyRole()` uses a single, deliberately
family-agnostic rule list (by design — see that file's header comment: a
flat list lets canonical-role title evidence work even when `role_family`
is itself wrong, since `matching/role-score.mjs` always trusts the job's
own `role_family` column for family-level comparisons, never this
function's). That design choice meant a HIGH-confidence canonical-role
title match (e.g. "ML Engineer" → `ML_ENGINEER`, confidence 0.9) could
still get persisted next to whatever `role_family` `classifyCategory()`
separately produced — and `classifyCategory()` itself had a real bug:
`lib/fingerprint.mjs`'s `software_engineering` tier listed bare
`ml engineer`, `machine learning`, `ai engineer`, `llm`, `nlp`,
`deep learning`, `artificial intelligence` as triggers, while its earlier
`data_science` tier only caught the exact spelled-out phrase
`machine learning engineer` — so "Senior ML Engineer" landed
`role_family=SOFTWARE_ENGINEERING` while `canonical_role=ML_ENGINEER`
(taxonomy family `DATA_SCIENCE`). This reproduced on every NEW job with
this title shape, not just historical rows — confirmed live (see the audit
numbers in the final report).

Two independent fixes, both necessary:

1. **Root cause** (`lib/fingerprint.mjs`, `CATEGORY_CLASSIFIER_VERSION`
   bumped to `role-family-v2.4`): moved the ML/AI-specific terms out of
   the `software_engineering` tier into the `data_science` tier, matching
   the taxonomy's own `ML_ENGINEER`/`AI_ENGINEER` → `DATA_SCIENCE` mapping.
2. **Defense in depth** (`lib/role-classifier.mjs`, `CLASSIFIER_VERSION`
   bumped to `role-v2.2`): `reconcileFamily()` — for ANY future case where
   `classifyRole()`'s title evidence for a canonical role disagrees with
   the already-assigned `role_family`, not just this specific bug.

## Confidence-based resolution (spec Steps 6-7)

`reconcileFamily(roleFamily, canonicalRole, confidence)` in
`lib/role-classifier.mjs`:

- **confidence ≥ 0.75** (this module's own "explicit phrase"/"compound
  evidence" tiers) **and** `canonicalRole` is a known taxonomy entry whose
  family disagrees with the input `roleFamily` → the family is corrected
  to the canonical role's one declared family. High-confidence title
  evidence for the *finer* signal wins over the *broader* classifier's
  output (spec's own worked example: 0.98 canonical vs. 0.55 family — the
  family is what's wrong).
- **confidence < 0.75** → never overrides family. Falls back to the job's
  existing `role_family`, generically (not forcing a finer-but-wrong
  guess) — spec Step 6's explicit policy: prefer `role_family` known +
  `canonical_role` null/generic over a confident-looking but invalid pair.

`lib/normalize.mjs`'s `normalizeJob()` then runs
`validateRoleClassification()` on the result as a last-resort safety net —
should never fire given `reconcileFamily` already resolves every case
`classifyRole` can produce, but guarantees nothing invalid is ever
persisted silently if some other code path changes shape later.

## Audit categories (spec Step 2)

| Bucket | Meaning |
|---|---|
| `CONSISTENT` | Valid — either a known canonical role matching its declared family (and specialization, if any), or the intentional not-deepened state (`canonical_role === role_family`) for a family outside the three deep ones. |
| `CANONICAL_ROLE_FAMILY_MISMATCH` | A known canonical role whose declared family disagrees with the stored `role_family`. Always invalid. |
| `SPECIALIZATION_CANONICAL_MISMATCH` | `role_specialization` set but not in the canonical role's declared set. Always invalid. |
| `UNKNOWN_CANONICAL` | `canonical_role IS NULL`, `role_family` known. Allowed (spec Step 6/13). |
| `UNKNOWN_FAMILY` | `role_family IS NULL`. Allowed, but should not occur in practice — `CATEGORY_TO_ROLE_FAMILY` always resolves to at least `'OTHER'`. |
| `LEGACY_FAMILY_FALLBACK` | `canonical_role === role_family` **within one of the three deepened families** (`SOFTWARE_ENGINEERING`/`DATA_SCIENCE`/`DEVOPS_SRE`) — the classifier's own "nothing finer matched" fallback. Valid, just reported separately from `CONSISTENT` since it represents a title the classifier couldn't deepen. |
| `OTHER` | Anything not covered above (defensive catch-all; should be empty in practice). |

## Repair procedure

```bash
node --env-file=.env.local scripts/audit-role-consistency.mjs             # read-only, reports current state
node --env-file=.env.local scripts/backfill-role-consistency.mjs --dry-run # shows intended changes, writes nothing
node --env-file=.env.local scripts/backfill-role-consistency.mjs          # re-runs the fixed pipeline, writes changes
node --env-file=.env.local scripts/backfill-role-consistency.mjs --force  # reclassify every row regardless of classifier version already recorded
node --env-file=.env.local scripts/test-role-consistency.mjs              # DB-free regression suite
```

The repair script **re-runs the actual classification pipeline from each
job's title** (`classifyCategory()` → `classifyRole()`) — it never
hardcodes a SQL rewrite like `IF canonical_role='ML_ENGINEER' THEN
role_family='DATA_SCIENCE'` (spec Step 11), because that would only fix
the specific pairs enumerated by hand and would reproduce on the next
ingested job with the same title pattern. Idempotent and resumable
exactly like the existing `scripts/backfill-roles.mjs`: a job already
classified at the current `canonical_role` classifier version
(`role-v2.2`) is skipped (`NOT EXISTS` against `job_classifications`,
indexed) unless `--force`; `--since-id` resumes directly after an
interruption.

Audit trail (spec Step 12): every repaired field gets a new
`job_classifications` row (`field_name` = `role_family` / `canonical_role`
/ `role_specialization`) carrying the new value, the classifier version,
confidence, and an `evidence` string that embeds the previous value and
the repair reason. Nothing is deleted — the prior classifier version's row
(if any) stays in the table, so the full history is still queryable by
`classifier_version`.

## Monitoring query (spec Step 23 — `role_taxonomy_consistency_rate`)

```sql
-- Overall
SELECT role_family, canonical_role, role_specialization, COUNT(*) n
  FROM jobs WHERE status='READY' AND active=TRUE
 GROUP BY role_family, canonical_role, role_specialization;
-- then classifyRow() each group in JS (scripts/audit-role-consistency.mjs) —
-- never duplicate the mapping as a second SQL CASE statement.

-- Windowed (last 24h/7d) — same query with:
--   AND discovered >= NOW() - INTERVAL '24 hours'   -- or '7 days'
```

`scripts/audit-role-consistency.mjs --window 6h|24h|7d` runs this
end-to-end and reports the consistency rate for that window — the
live-ingestion health check (spec Step 9): if recent jobs still show
invalid combinations, the ingestion path (not just historical backfill) is
still broken.

## DB-level enforcement — evaluated, not implemented (spec Step 16)

**Recommendation: application-level validation only (what's described
above) — no DB constraint.**

Considered and rejected:
- **A `CHECK` constraint enumerating every valid (`canonical_role`,
  `role_family`) pair.** Rejected: the taxonomy has already grown across
  multiple phases of this project (role-family-v2 → role-v2 → role-v2.1 →
  this phase) and will keep evolving; a constraint listing every valid
  pair must be migrated in lockstep with every taxonomy change or it
  starts rejecting legitimate new rows the moment code ships a new
  canonical role ahead of a matching migration — exactly the "giant
  brittle constraint" spec Step 16 warns against.
- **A separate SQL reference/lookup table mirroring `CANONICAL_ROLES`,
  enforced via foreign key.** Rejected as unnecessary complexity for this
  codebase's actual write pattern: every single write path that sets
  `role_family`/`canonical_role`/`role_specialization` (`scanner/
  worker.mjs` → `normalizeJob()`, and every backfill script) already
  funnels through `lib/role-classifier.mjs`/`lib/role-taxonomy.mjs` in
  the SAME process — there is no raw/ad-hoc SQL writer of these columns
  to guard against. A reference table would add a second source of truth
  to keep in sync with the JS taxonomy for no real protection gained.

Application-level validation (`validateRoleClassification()`, called at
both ingestion time and backfill time) plus the periodic audit script
above gives equivalent protection with zero migration coupling to
taxonomy changes. Revisit this recommendation only if a second,
independent write path to these columns is ever added outside this
classification pipeline.
