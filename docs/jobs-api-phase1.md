# Jobs API Phase 1

Base URL: `http://localhost:3001`

## `GET /jobs`

The endpoint returns active jobs whose status is `READY` or `NULL` for legacy compatibility.

Supported query parameters:

- `q`
- `category`
- `role_family`
- `workplace_type`
- `employment_type`
- `sponsorship_status`
- `experience_max`
- `salary_min`
- `state`
- `ats`
- `company_id`
- `remote=true|false`
- `limit`
- `page`
- `sort=oldest|salary|experience`

The default sort is newest discovered jobs first. The endpoint preserves the existing response shape and adds canonical fields to each list result.

## Verification

Run:

```bash
npm run test:jobs-api
```

The Phase 1 suite covers no-filter, search, every structured filter individually, every supported sort, and combined filters.
