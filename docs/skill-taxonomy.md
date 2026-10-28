# Skill taxonomy and extraction

## Authoritative model

- **Taxonomy (source of truth):** `data/skills-taxonomy.json` — a versioned list of skills, each with a canonical name, a stable `normalizedName` (the FK key used everywhere else), a category, and the alias surface forms to match in job text.
- **Matching engine:** `lib/skill-taxonomy.mjs` loads and compiles the JSON once per process into regex matchers and two lookup maps (extraction matchers; free-text alias → normalizedName).
- **Extraction:** `lib/skill-extract.mjs`'s `extractSkills(description)` scans a job description against the compiled taxonomy and returns `{name, canonicalName, category, importance, confidence, evidence}` per skill found.
- **Normalization:** `lib/skills.mjs`'s `normalizeSkillName(value)` — used by `server.mjs`'s skills filter and (a manually-synced copy of the alias table) by `public/index.html`'s profile-match — resolves a free-text skill string (e.g. a filter query term or a resume-parsed skill) to the same `normalizedName` space.
- **Storage:** `skills` (canonical_name, normalized_name, category) and `job_skills` (job_id, skill_id, importance, confidence, evidence) — unchanged tables, now populated with real `category` values and human-readable `canonical_name` casing.
- **Versioning:** `jobs.extraction_version` is stamped with the taxonomy's `version` field (currently `skills-v2`) whenever a job's skills are (re)computed, by both the live scanner and the backfill script.

## Adding a skill (data change, not a code change)

Append an entry to `data/skills-taxonomy.json`:

```json
{ "canonicalName": "Terraform Cloud", "normalizedName": "terraform cloud", "category": "DEVOPS", "aliases": ["terraform cloud"] }
```

Then run `node --env-file=.env.local scripts/backfill-skills.mjs` to backfill it onto existing jobs (only jobs missing the current extractor version are touched — see Backfill below). No code changes needed unless the new skill's aliases collide with a common English word (see below).

If the alias set changes for an **existing** frontend-relevant skill (adding a new alias), also update the generated `SKILL_ALIASES` object at the top of `public/index.html`'s `<script>` block — it's a static HTML page with no build step, so this one table is kept in manual sync rather than loaded from the JSON at runtime. A one-line comment above it explains this.

## Matching precision — why some entries have `caseSensitive`/`exclude`

Naive `\bskill\b` substring matching produces severe false positives when a skill name is also an ordinary English word or an unrelated proper noun. A live-corpus audit (before this taxonomy existed) found, among others:

- **`go`** matched 17,062 times — almost entirely the common verb ("go above and beyond", "go-to-market"), not the Go language.
- **`spark`** matched mostly **"Spark Capital"**, a VC firm named in funding-history boilerplate, and motivational verbs ("spark innovation/curiosity") — not Apache Spark.
- **`excel`** matched the verb ("opportunity to excel") as often as the Microsoft Excel product.
- **`airflow`** matched HVAC ductwork/venting text in industrial job postings, not Apache Airflow.
- **`c++`/`c#`** never actually matched anything under the old `\bc\+\+\b`-style pattern (word-boundary assertions don't behave as expected when the token ends in punctuation) — a silent false-negative bug, not a false positive.

The fix, encoded as data rather than special-cased code:

- **`caseSensitive: true`** — the alias must match with its exact stored case (e.g. `"Go"`, not `"go"`). This alone eliminates most of the above, since the false-positive usage is essentially always lowercase mid-sentence while the real skill mention is capitalized as a proper noun.
- **`exclude: [...]`** — literal phrases; if one appears within a tight window (15 chars) directly around a match, that specific match is discarded. Used for cases `caseSensitive` alone doesn't resolve because the colliding phrase is *also* capitalized (`"R&D"`, `"C++"`/`"C#"` adjacency, `"Terran R"` — a rocket product name that happened to end in the letter R).
- **Bare aliases dropped entirely** where no matching-time heuristic gives acceptable precision: `spark` (kept only as `"apache spark"`/`"pyspark"`), `emr` (kept only as `"amazon emr"`/`"aws emr"` — collides with Electronic Medical Records in healthcare postings), `lambda` (kept only as `"aws lambda"` — collides with the Greek letter/math usage).
- **Boundary matching itself** was rebuilt on lookaround (`(?<![A-Za-z0-9_])alias(?![A-Za-z0-9_])`) instead of `\b`, so punctuation-ending aliases like `C++`/`C#`/`Node.js` match correctly (see the c++ false-negative above) while `Go` still correctly never matches inside `Google` and `Java` never matches inside `JavaScript`.

This list is not exhaustive — see Known limitations below for a case (`R` inside other product-name-like tokens) found during backfill verification that a generic heuristic can't fully close.

## Importance classification (REQUIRED / PREFERRED / MENTIONED)

Per-match, not whole-document:

1. **Section-based** (primary): the text is scanned once for section-header phrases (`Requirements:`, `Minimum Qualifications:`, `Preferred Qualifications:`, `Nice to have:`, etc.), building an ordered list of `(position, tag)`. A skill match takes the tag of the nearest preceding header, if any.
2. **Bounded-window fallback**: if no header precedes the match, a ±250-character window around the match is checked for requirement/preference keyword phrases (`required`, `must have`, `at least`, `preferred`, `nice to have`, `bonus`, `plus`, ...).
3. **Default**: `MENTIONED` if neither applies.

This directly replaces the old behavior, which classified every skill found anywhere in a description as REQUIRED if the word "required" appeared *anywhere at all* in the text — meaning one "Requirements" section header downstream could mislabel a skill mentioned only in the company-boilerplate paragraph at the top.

## Confidence and evidence

- `confidence` starts at the skill's `baseConfidence` (default 0.8; lower — 0.4–0.65 — for the inherently ambiguous short tokens above, even after `caseSensitive`/`exclude` narrowing) and gets a small bump (capped at 0.95) when a section header, not just a window, backs the importance call.
- `evidence` is a ~140-character excerpt centered on the match (with `…` truncation markers), not the whole description — enough to audit why a skill was extracted without storing large text blobs.

## Backfill

`scripts/backfill-skills.mjs`:

- Resumable/idempotent: by default only processes jobs whose `extraction_version` isn't already the current taxonomy version — safe to re-run after an interruption, and a version bump in the taxonomy JSON automatically makes every job eligible for reprocessing again (no `--force` needed for an ordinary taxonomy edit).
- `--force` reprocesses every job regardless of `extraction_version` (for a matching-logic change that didn't bump the taxonomy version).
- Batch-based (`SKILLS_BATCH`, default 150) with a small inter-batch pause and retry-with-backoff per batch (the recurring failure mode on this project's RDS instance is autovacuum/scanner I/O contention causing transient statement timeouts, not a bug in the script — see `scripts/backfill-seniority.mjs` for the same pattern established earlier).
- `lib/db.mjs`'s `upsertExtractedSkills` recomputes each job's full skill set from scratch per run and **deletes any `job_skills` row for that job the current extraction did not reproduce** — so a false positive fixed in the taxonomy (or an alias removed) cleans itself up on the next backfill instead of accumulating stale rows forever.
- Reads `description_clean`, already stored from the original scrape — no re-scraping needed to re-run extraction.

## Known limitations

- `extractSkills` still can't distinguish domain-specific homonyms it hasn't been told about explicitly (see `R` matching inside `"Terran R"`, a rocket name, until that specific phrase was added to `R`'s exclude list after being caught in backfill spot-checking). New single/two-letter or acronym skills should be added with a low `baseConfidence` and reviewed against real data before trusting them at scale.
- The taxonomy is curated, not corpus-exhaustive — see the gap-analysis notes in the phase's final report for what was added from a live-corpus scan (`Salesforce`, `Linux`/`Unix`, `Microsoft Office`, `ERP`, `RFID`, `CCTV`) and what was deliberately left out (long-tail one-off terms).
- Non-technical/industrial postings genuinely contain few or no matches from a technology-skewed taxonomy; a low skills-coverage rate for that job mix is expected, not a bug.
