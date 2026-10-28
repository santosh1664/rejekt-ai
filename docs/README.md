# Rejekt.ai — Documentation

This folder contains all technical and product documentation for the project.

## Index

| File | What's inside |
|------|---------------|
| [PRD.md](./PRD.md) | Product Requirements Document — vision, goals, features, success metrics |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture, component map, data flow |
| [DATABASE.md](./DATABASE.md) | Schema reference, indexes, migration guide |
| [API.md](./API.md) | REST API endpoints, request/response shapes |
| [WORKFLOWS.md](./WORKFLOWS.md) | Operational workflows — scan, harvest, match, freshen |
| [PROVIDERS.md](./PROVIDERS.md) | ATS provider integration details |
| [SETUP.md](./SETUP.md) | Local dev setup, environment variables, running the stack |

## Project Layout

```
rejekt-ai/
├── docs/                  ← you are here
├── public/                ← frontend (index.html — single-file SPA)
├── server.mjs             ← Express web server + API
├── scanner.mjs            ← CLI entrypoint for scan / harvest / freshen
├── scanner/
│   ├── orchestrator.mjs   ← parallel ATS scanning engine
│   └── worker.mjs         ← per-company job fetcher + dedup logic
├── providers/             ← one module per ATS (Greenhouse, Ashby, Lever…)
├── harvester/             ← Common Crawl company discovery
├── freshness/             ← closed-job detection
├── matching/              ← user ↔ job matching engine
├── ml/                    ← Python ML classifier (category + fields)
├── lib/                   ← shared utilities (db, pool, geo, fingerprint…)
├── db/                    ← schema SQL + migration scripts
└── scripts/               ← one-off maintenance scripts
```
