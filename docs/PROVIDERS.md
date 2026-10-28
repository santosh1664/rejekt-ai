# ATS Provider Integration Reference

This document describes each Applicant Tracking System (ATS) provider integrated into Rejekt.ai — their API patterns, authentication, concurrency limits, field mappings, and known quirks.

---

## Overview

| Provider | Type | Auth | Concurrency | Est. Jobs/Company |
|---|---|---|---|---|
| Greenhouse | REST JSON | Public board key | 8 | 10–500 |
| Ashby | REST JSON | Public board slug | 6 | 5–300 |
| Lever | REST JSON | Subdomain | 4 | 5–200 |
| Workday | HTML scrape | Cookie/session | 3 | 10–1000 |
| BambooHR | REST JSON | Subdomain | 4 | 2–100 |
| Workable | REST JSON | Subdomain | 4 | 5–200 |
| SmartRecruiters | REST JSON | Company slug | 4 | 5–500 |

---

## Greenhouse

**Base URL**: `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs`

### Authentication
No API key required. The `board_token` is the public identifier visible in the company's job board URL (e.g., `https://boards.greenhouse.io/acme` → token is `acme`).

### Endpoints Used
```
GET /v1/boards/{board_token}/jobs?content=true
```
- `content=true` returns the full job description HTML
- Returns paginated JSON with all active jobs

### Response Shape
```json
{
  "jobs": [
    {
      "id": 12345,
      "title": "Senior Engineer",
      "location": { "name": "San Francisco, CA" },
      "content": "<div>Job description HTML...</div>",
      "updated_at": "2024-01-15T10:00:00.000Z",
      "absolute_url": "https://boards.greenhouse.io/acme/jobs/12345",
      "departments": [{ "name": "Engineering" }],
      "offices": [{ "name": "San Francisco" }]
    }
  ]
}
```

### Field Mapping
| Greenhouse Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `title` | `title` |
| `location.name` | `location` |
| `content` | `description` |
| `updated_at` | `posted_at` |
| `absolute_url` | `job_url` |
| `departments[0].name` | `department` |

### Concurrency: 8
Greenhouse's CDN-backed API handles high concurrency well. Rate limits are generous for public board access.

### Known Quirks
- `content` field returns raw HTML — strip tags before storing/indexing
- Some companies use multiple board tokens (acquired subsidiaries). Each must be scanned separately.
- `updated_at` reflects last edit, not original post date — can jump around on minor edits
- Job IDs are numeric but the URL path uses the same integer

---

## Ashby

**Base URL**: `https://api.ashbyhq.com/posting-api/job-board/{board_slug}`

### Authentication
No API key required. The `board_slug` matches the subdomain in `https://jobs.ashbyhq.com/{slug}`.

### Endpoints Used
```
GET /posting-api/job-board/{board_slug}?includeCompensation=true
```

### Response Shape
```json
{
  "jobs": [
    {
      "id": "abc-123-uuid",
      "title": "Product Manager",
      "team": "Product",
      "isRemote": true,
      "location": "New York, NY",
      "jobUrl": "https://jobs.ashbyhq.com/acme/abc-123",
      "descriptionHtml": "<p>We are looking for...</p>",
      "publishedAt": "2024-01-10T00:00:00.000Z",
      "compensation": {
        "minValue": 120000,
        "maxValue": 160000,
        "currency": "USD",
        "interval": "YEARLY"
      }
    }
  ]
}
```

### Field Mapping
| Ashby Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `title` | `title` |
| `location` | `location` |
| `descriptionHtml` | `description` |
| `publishedAt` | `posted_at` |
| `jobUrl` | `job_url` |
| `team` | `department` |
| `compensation.minValue` | `salary_min` |
| `compensation.maxValue` | `salary_max` |

### Concurrency: 6
Ashby's API is reliable but occasionally returns 429 under high load. Back off 5s on 429.

### Known Quirks
- Job IDs are UUIDs, not integers
- `isRemote: true` is available — use to set `remote_ok` flag
- Compensation data is structured and reliable when present (not all jobs include it)
- `descriptionHtml` is well-structured — better for parsing than Greenhouse's raw HTML

---

## Lever

**Base URL**: `https://api.lever.co/v0/postings/{company}`

### Authentication
No API key required. `company` is the subdomain used in `https://jobs.lever.co/{company}`.

### Endpoints Used
```
GET /v0/postings/{company}?mode=json&limit=250
```
- `mode=json` returns structured data (default returns HTML)
- `limit=250` gets max results per page; paginate via `offset`

### Response Shape (array)
```json
[
  {
    "id": "abc123def456",
    "text": "Backend Engineer",
    "categories": {
      "team": "Engineering",
      "location": "Remote",
      "commitment": "Full-time",
      "department": "Platform"
    },
    "description": "<p>Lever job description...</p>",
    "hostedUrl": "https://jobs.lever.co/acme/abc123",
    "createdAt": 1705276800000,
    "lists": [
      { "text": "Requirements", "content": "<li>5+ years exp</li>" }
    ]
  }
]
```

### Field Mapping
| Lever Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `text` | `title` |
| `categories.location` | `location` |
| `description` | `description` |
| `createdAt` (ms epoch) | `posted_at` |
| `hostedUrl` | `job_url` |
| `categories.team` | `department` |

### Concurrency: 4
Lever's API can be slow and occasionally times out. Lower concurrency prevents flooding.

### Known Quirks
- `createdAt` is a Unix timestamp in **milliseconds** — divide by 1000 for seconds
- Response is a JSON array (not wrapped in an object)
- `lists` array contains structured sections (Requirements, Responsibilities) — useful for ML extraction
- Some companies have thousands of postings; always paginate
- `categories.commitment` contains employment type: `"Full-time"`, `"Part-time"`, `"Contract"`, `"Internship"`

---

## Workday

**Base URL**: Dynamic per company (no standard format)

### Authentication
Workday uses session cookies for scraping. The scanner navigates the public careers site and extracts job data from the client-rendered page or the internal WQL API endpoint.

### Common URL Patterns
```
https://{company}.wd1.myworkdayjobs.com/en-US/{career_site}/jobs
https://{company}.wd5.myworkdayjobs.com/External_Career_Site/jobs
```
Some companies alias to custom domains like `careers.microsoft.com`.

### Extraction Method
1. Navigate to the careers page
2. Detect `wday_vps_application_url` meta tag or the WQL endpoint in network requests
3. Hit the internal API: `GET /api/apply/{tenant}/jobs?limit=20&offset=0&types=Job`
4. Parse the `jobPostings` array from the JSON response

### Response Shape (WQL internal API)
```json
{
  "jobPostings": [
    {
      "externalId": "R-12345",
      "title": "Software Engineer II",
      "locationsText": "Seattle, WA, USA",
      "timeType": "Full time",
      "postedOn": "Posted 30+ Days Ago",
      "externalPath": "/job/R-12345/Software-Engineer-II"
    }
  ],
  "total": 847
}
```

### Concurrency: 3
Workday's infrastructure is sensitive to rapid requests. Exceeding 3 concurrent requests often results in temporary IP-level throttling.

### Known Quirks
- No public API — extraction is effectively scraping
- WQL endpoint version varies (`wd1`, `wd3`, `wd5`) per company
- `postedOn` is a relative string like `"Posted 7 Days Ago"` — must be parsed to a date
- Full job description requires a second request per job (description not in listing endpoint)
- Some Workday instances require JavaScript execution (fully client-rendered)
- Custom domain mappings require a lookup table (`workday_domains.json`)

---

## BambooHR

**Base URL**: `https://{subdomain}.bamboohr.com/careers/list`

### Authentication
No API key required for public job listings. Subdomain is visible in the company's HR portal URL.

### Endpoints Used
```
GET /careers/list
```
Returns JSON array of all open positions.

### Response Shape
```json
[
  {
    "id": "123",
    "jobOpeningName": "Marketing Manager",
    "locationCity": "Austin",
    "locationState": "TX",
    "locationCountry": "United States",
    "employmentStatusLabel": "Full-Time",
    "departmentLabel": "Marketing",
    "jobUrl": "https://acme.bamboohr.com/careers/123"
  }
]
```

### Field Mapping
| BambooHR Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `jobOpeningName` | `title` |
| `locationCity + locationState` | `location` |
| `departmentLabel` | `department` |
| `jobUrl` | `job_url` |

### Concurrency: 4
Reliable API, generous rate limits.

### Known Quirks
- No `description` in the list endpoint — requires a second request to `GET /careers/{id}` for full description
- Location is split across `locationCity`, `locationState`, `locationCountry` — concatenate for storage
- Some companies have both BambooHR and a second ATS — check for duplicate jobs by title+company
- Job descriptions at the detail endpoint are plain text, not HTML

---

## Workable

**Base URL**: `https://{subdomain}.workable.com/api/v3/accounts/{subdomain}/jobs`

### Authentication
No API key required for public listings. Subdomain matches the company's Workable careers URL.

### Endpoints Used
```
GET /api/v3/accounts/{subdomain}/jobs?state=published&limit=100
```

### Response Shape
```json
{
  "jobs": [
    {
      "id": "ABC123",
      "title": "DevOps Engineer",
      "location": {
        "city": "Boston",
        "region": "Massachusetts",
        "country": "US",
        "telecommuting": false
      },
      "department": "Infrastructure",
      "url": "https://acme.workable.com/jobs/ABC123",
      "created_at": "2024-01-12T09:00:00Z",
      "employment_type": "full_time"
    }
  ],
  "paging": {
    "next": "https://...?since_id=ABC123"
  }
}
```

### Field Mapping
| Workable Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `title` | `title` |
| `location.city + region` | `location` |
| `location.telecommuting` | `remote_ok` |
| `department` | `department` |
| `url` | `job_url` |
| `created_at` | `posted_at` |

### Concurrency: 4
Workable rate limits at ~60 req/min per subdomain; concurrency of 4 stays well within this.

### Known Quirks
- Pagination uses cursor-based `since_id` — follow `paging.next`
- `employment_type` values: `full_time`, `part_time`, `contract`, `temporary`, `internship`
- `location.telecommuting: true` maps to remote-friendly roles
- Full description requires `GET /api/v3/accounts/{subdomain}/jobs/{id}` — has `description` and `requirements` fields
- Some subdomains are mapped to custom domains (e.g., `careers.acme.com`) — requires URL normalization

---

## SmartRecruiters

**Base URL**: `https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings`

### Authentication
No API key for public job listings. `companyIdentifier` matches the slug used in `https://careers.smartrecruiters.com/{companyIdentifier}`.

### Endpoints Used
```
GET /v1/companies/{companyIdentifier}/postings?limit=100&offset=0
```

### Response Shape
```json
{
  "content": [
    {
      "id": "def456ghi789",
      "name": "Senior Data Scientist",
      "location": {
        "city": "New York",
        "region": "New York",
        "country": "us"
      },
      "department": { "label": "Data & Analytics" },
      "typeOfEmployment": { "label": "Permanent" },
      "ref": "https://careers.smartrecruiters.com/Acme/def456ghi789",
      "releasedDate": "2024-01-08T00:00:00.000+0000"
    }
  ],
  "totalFound": 42,
  "offset": 0,
  "limit": 100
}
```

### Field Mapping
| SmartRecruiters Field | DB Column |
|---|---|
| `id` | `ats_job_id` |
| `name` | `title` |
| `location.city + region` | `location` |
| `department.label` | `department` |
| `ref` | `job_url` |
| `releasedDate` | `posted_at` |

### Concurrency: 4

### Known Quirks
- Pagination is offset-based — iterate until `offset + content.length >= totalFound`
- `typeOfEmployment.label` values include: `"Permanent"`, `"Contract"`, `"Part Time"`, `"Temporary"`, `"Internship"`
- Full description: `GET /v1/companies/{id}/postings/{postingId}` — returns `jobAd.sections.jobDescription.text`
- `releasedDate` is in ISO 8601 with timezone offset — parse carefully
- Some companies use SmartRecruiters internal IDs as `companyIdentifier` (numeric) vs. slug (string)

---

## Adding a New Provider

To integrate a new ATS provider:

1. **Identify the public jobs API** — look at network requests on the company's careers page
2. **Add provider config** to `config/providers.json`:
   ```json
   {
     "id": "newats",
     "name": "NewATS",
     "urlPattern": "https://jobs.newats.com/{slug}",
     "apiTemplate": "https://api.newats.com/v1/{slug}/jobs",
     "concurrency": 4
   }
   ```
3. **Write a provider module** in `providers/newats.js`:
   - Export `async function fetchJobs(company)` returning normalized job objects
   - Normalize to the standard shape: `{ ats_job_id, title, location, description, posted_at, job_url, department, remote_ok, salary_min, salary_max }`
4. **Register in scanner** (`scripts/scanCompanies.js`): import and add to the `PROVIDERS` map
5. **Test** with a known company: `node scripts/scanCompanies.js --company="Acme" --provider=newats --dry-run`
6. **Document** the provider in this file following the template above
