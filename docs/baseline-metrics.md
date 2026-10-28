# Job Platform Baseline Metrics

Captured: 2026-09-26

## Data volume and completeness

| Metric | Value |
|---|---:|
| Total jobs | 102,585 |
| Active jobs | 89,779 |
| Inactive jobs | 12,806 |
| Missing titles | 1 |
| Missing companies | 0 |
| Missing locations | 9 |
| Missing descriptions | 180 |
| Distinct URLs | 102,585 |
| Duplicate company/title rows | 18,012 |

The duplicate company/title value is a diagnostic count, not a deletion recommendation. Multiple legitimate requisitions can share a company and title.

## Classification distribution

The current corpus is predominantly ML-classified. The largest categories are:

| Category | Source | Jobs |
|---|---|---:|
| `software_engineering` | ML | 19,848 |
| `sales` | ML | 11,470 |
| `operations` | ML | 10,409 |
| `industrial_engineering` | ML | 7,554 |
| `healthcare` | ML | 7,306 |
| `it_operations` | ML | 6,412 |
| `marketing` | ML | 4,085 |
| `finance` | ML | 3,996 |
| `product_management` | ML | 3,762 |
| `other` | Keyword | 3,486 |
| `data_science` | ML | 3,075 |

The full category/source breakdown remains available from:

```sql
SELECT category, category_source, COUNT(*) AS jobs
FROM jobs
GROUP BY category, category_source
ORDER BY jobs DESC;
```

## Representative PostgreSQL query plans

```text
Active jobs ordered by discovery, limit 25:
Execution Time: 0.194 ms
Buffers: shared hit=25
Index: idx_jobs_discovered

Active software-engineering jobs ordered by discovery, limit 25:
Execution Time: 0.416 ms
Buffers: shared hit=121
Index: idx_jobs_discovered
```

These are warm-cache measurements from the current database and should not be treated as a P95 latency figure.

## API timing

Measured with `curl` against the local API process:

| Request | HTTP | Total time |
|---|---:|---:|
| `GET /health` | 200 | 0.501 seconds |
| `GET /jobs?limit=25` | 200 | 0.253 seconds |

The health request includes connection establishment or pool wake-up overhead. Repeat measurements are required before drawing conclusions about P95 behavior.

## Baseline goals for later phases

- Preserve all raw source payloads while separating raw and canonical records.
- Reduce missing descriptions and locations through deterministic normalization where source data permits.
- Measure duplicate candidates without automatically merging legitimate requisitions.
- Add structured search and compare its latency with the current title/company search.
- Establish classification coverage, confidence, and evidence metrics before changing ranking.
