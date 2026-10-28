# REST API Reference
**Base URL:** `http://localhost:3000`

All endpoints return `application/json`. Errors: `{ "error": "<message>" }`.

---

## GET `/api/meta`

Returns headline counts and filter option lists for the UI.

**Response**
```json
{
  "categories": [{ "category": "engineering", "n": "52000" }, ...],
  "ats": [{ "ats": "greenhouse", "n": "28000" }, ...],
  "totals": { "total": "89820", "remote": "14163", "companies": "3358" },
  "workplaceTypes": [{ "workplace_type": "REMOTE", "n": "14163" }, ...]
}
```

---

## GET `/api/jobs`

Search and filter the jobs feed. Returns paginated results with total count.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | `""` | Full-text search query |
| `searchField` | `title\|both` | `both` | Search title only or title+company |
| `category` | string | — | Single category filter (legacy) |
| `categories` | CSV | — | Multi-category filter (preferred) |
| `ats` | string | — | Filter by ATS provider |
| `remote` | `true\|false` | — | Filter by remote flag |
| `page` | int | `1` | Pagination page |
| `pageSize` | int | `20` | Results per page (max 50) |
| `careerLevels` | CSV | — | `ENTRY,MID,SENIOR,LEAD,MANAGER` |
| `employmentTypes` | CSV | — | `FULL_TIME,CONTRACT,PART_TIME,INTERNSHIP` |
| `workplaceTypes` | CSV | — | `REMOTE,HYBRID,ON_SITE` |
| `sponsorship` | string | — | `AVAILABLE\|NOT_AVAILABLE` |
| `degreeLevel` | string | — | `BACHELOR\|MASTER\|PHD` |
| `salaryMin` | int | — | Minimum salary (USD annual) |
| `salaryMax` | int | — | Maximum salary (USD annual) |
| `minExpYears` | int | — | Minimum years of experience |
| `maxExpYears` | int | — | Maximum years of experience |
| `visa` | string | — | Alias for `sponsorship=AVAILABLE` |
| `platforms` | CSV | — | Comma-separated ATS names |
| `degree` | string | — | Alias for `degreeLevel` |

**Response**
```json
{
  "jobs": [
    {
      "id": 123456,
      "title": "Senior Software Engineer",
      "company": "Acme Corp",
      "location": "San Francisco, CA",
      "remote": true,
      "url": "https://boards.greenhouse.io/acmecorp/jobs/123",
      "ats": "greenhouse",
      "category": "engineering",
      "posted_at": "2026-09-20T00:00:00.000Z",
      "discovered": "2026-09-21T04:12:33.000Z",
      "career_level": "SENIOR",
      "employment_type": "FULL_TIME",
      "workplace_type": "REMOTE",
      "sponsorship": "AVAILABLE",
      "salary_min": 150000,
      "salary_max": 200000,
      "score": 8432
    }
  ],
  "total": 89820,
  "page": 1,
  "pageSize": 20
}
```

`score` is `ts_rank() × 10000` — higher = better text match. Omitted when no `q` provided.

---

## GET `/api/job/:id`

Fetch a single job with full description.

**Response**
```json
{
  "id": 123456,
  "title": "Senior Software Engineer",
  "company": "Acme Corp",
  "description": "We are looking for...",
  "url": "https://...",
  ...
}
```

---

## GET `/api/scan-log`

Server-sent events (SSE) stream of live scanner progress. Also returns the latest N scan run rows for the dashboard.

---

## POST `/api/parse-resume`

Upload a résumé file; returns structured profile fields.

**Request** — `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `resume` | File | `.pdf`, `.docx`, `.doc`, or `.txt` |

**Response**
```json
{
  "name": "Roy Sharma",
  "email": "roy@example.com",
  "phone": "+1 (555) 123-4567",
  "linkedin": "linkedin.com/in/roysharma",
  "github": "github.com/roysharma",
  "location": "Dallas, TX",
  "title": "Software Engineer",
  "summary": "Full-stack engineer with 3+ years...",
  "workAuth": "authorized",
  "expYears": "3-5",
  "skills2": {
    "languages": ["Java", "Python", "JavaScript"],
    "frameworks": ["Spring Boot", "React"],
    "databases": ["PostgreSQL", "Redis"],
    "tools": ["Docker", "Git"],
    "cloud": ["AWS"],
    "soft": []
  },
  "certs": [
    { "name": "AWS Solutions Architect", "issuer": "", "year": "" }
  ]
}
```

On error: `{ "error": "<message>" }` with HTTP 400 or 500.

---

## GET `/api/companies` *(planned)*

List/search companies in the `companies` table.

## POST `/api/companies` *(planned)*

Add a company manually.

## PATCH `/api/companies/:id` *(planned)*

Update priority, active status.

