# Product Requirements Document
**Rejekt.ai** · v0.1 · Last updated: 2026-09-24

---

## 1. Vision

A self-hosted job discovery engine that pulls **every software job** posted directly on company career pages — bypassing aggregators like LinkedIn and Indeed — and surfaces them to job seekers through a fast, filter-rich interface with AI-powered profile matching.

---

## 2. Problem

Most job boards depend on company submissions or scrape LinkedIn. This creates:
- **Staleness** — postings are 1–3 days behind the source.
- **Incompleteness** — companies that don't pay aggregators are invisible.
- **Noise** — duplicate postings, mis-categorised roles, spam.

---

## 3. Goals

| # | Goal | Metric |
|---|------|--------|
| G1 | Index jobs from 20 000+ companies | ≥ 20k companies in `companies` table |
| G2 | Keep listings fresh | p95 job age < 24 h after a company scan |
| G3 | Zero duplicate jobs per company | fingerprint collision rate < 0.1 % |
| G4 | Fast search | p95 API response < 300 ms at 1 000 RPM |
| G5 | Accurate category classification | ML classifier accuracy ≥ 85 % on test set |
| G6 | Personalised match score | Match recall ≥ 70 % on labelled pairs |

---

## 4. User Personas

### 4.1 Job Seeker
- Actively looking for engineering / data / devops roles.
- Wants to avoid jobs they've already seen.
- Needs remote-first filter, salary hint, visa sponsorship info.

### 4.2 Operator / Self-Hoster
- Deploys the engine for a community, bootcamp, or personal use.
- Needs a CLI to manage companies, run scans, and inspect logs.

---

## 5. Features

### MVP (v0.1)
- **Company harvesting** via Common Crawl — bulk-discover companies on Greenhouse, Ashby, Lever, Workday, BambooHR, Workable, SmartRecruiters.
- **Parallel ATS scanning** — per-ATS concurrency pools, shard support (3-way horizontal split).
- **Deduplication** — SHA-256 fingerprint on `(company, normalised title)` prevents duplicates; cross-listing detection via `title_fp`.
- **Freshness checking** — jobs absent for N consecutive scans are marked `closed_at`.
- **ML classification** — scikit-learn model classifies job category and extracts structured fields (career level, employment type, salary, degree, sponsorship, workplace type).
- **Search API** — full-text + trigram search, multi-filter (category, ATS, remote, salary, experience years, degree, sponsorship, workplace type, career level).
- **Match score** — `ts_rank()` PostgreSQL FTS score returned per job; displayed as a percentage in the UI.
- **Frontend SPA** — single-file dark-mode UI with live filters, infinite scroll, "open original" link per job.
- **User profile drawer** — localStorage profile with resume parse, skill tags, job preferences, salary range, visa/work auth.
- **Resume auto-parse** — upload PDF/DOCX → backend extracts fields → pre-fills profile.
- **Scan log dashboard** — real-time scan progress, inside the admin portal at `/admin#/scans`.

### Planned (v0.2+)
- Auth + multi-user accounts.
- Email / push alerts when new matches appear.
- Saved searches and job bookmarks.
- Company priority management UI.
- Webhook / Zapier integration for outbound alerts.
- LinkedIn / Indeed import for cross-referencing.

---

## 6. Non-Goals (v0.1)

- Applying to jobs on behalf of users.
- Storing cover letters or application tracking.
- Paid job promotion / sponsored listings.

---

## 7. Constraints

- **Stack** — Node.js ≥ 20 (ESM), Express v5, PostgreSQL (AWS RDS or Neon), Python 3.10+ (ML).
- **Hosting** — designed to run on a single Mac / VPS for self-hosting; scanner is shardable for scale.
- **ATS rate limits** — each ATS has a dedicated concurrency pool; no per-IP bans expected at current throughput.

---

## 8. Success Metrics (Launch)

- 80 000 + active jobs indexed.
- Scan cycle completes < 4 h for 3 000 active companies.
- Search returns results < 200 ms (median).
- Zero data loss on server restart (all state in Postgres).

