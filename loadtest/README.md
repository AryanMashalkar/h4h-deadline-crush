# Load test: 2,000 teams in the last 10 minutes

**Result: API p95 11.7 ms (target < 300 ms), 1,960 / 1,960 uploads completed, 40 / 40 late attempts refused, 0 submissions lost.**

## What it does

`server/scripts/loadtest.ts` is an open-model test, like k6's `ramping-arrival-rate`: every team starts at its scheduled time, however slow the server is, so a slow server cannot hide by slowing the test down.

* 2,000 teams, deadline 10 minutes after seeding. Arrivals are back-loaded toward the deadline: the cumulative share by time t is (t/T)³, so about 27% of teams arrive in the last minute (peak ≈ 10 teams/s).
* Each team: `GET` status → start upload → sign parts → `PUT` straight to the bucket → complete → `GET` status. About 10% then save a second version. 2% (40 teams) try to start an upload 1 to 20 s **after** the deadline; all must be refused.
* Only API calls count toward API latency; bucket `PUT`s are listed separately.
* **Nothing-lost check afterwards:** wait for all checks to finish, then (1) the organizer reconciliation: `HEAD` every object a version points at and compare sizes, plus completed upload → version → job links; (2) per team, compare the SHA-256 the worker computed from the bytes in the bucket (from the CSV export) with the SHA-256 the client computed before uploading.

## Result (`results/local-2000-teams-10-min.json`)

| | |
|---|---|
| Teams | 2000 (1960 on time, 40 after the deadline) |
| Window | 596 s, back-loaded: cumulative share (t/T)³ |
| API requests | 10095 |
| **API p95** | **11.7 ms** (p50 3.5 ms, p99 14.4 ms, max 35.6 ms) |
| Uploads completed | 1960 / 1960 |
| Late attempts refused | 40 / 40 (accepted: 0) |
| Errors | none |
| **Lost submissions** | **0** (worker SHA-256 = client SHA-256 for 1960 / 1960) |
| Reconciliation | 1960 / 1960 objects found, 0 missing, 0 size mismatches, 0 uploads without a version, 0 versions without a job |
| Checks after the run | 1960 accepted, 0 checking, 0 dead jobs |

| Endpoint | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| GET submission | 3960 | 2.6 | 4.4 | 6.9 |
| POST start upload | 2000 | 8.2 | 11.6 | 14.6 |
| POST sign parts | 1960 | 3 | 4.6 | 6.5 |
| storage PUT part (not API) | 1960 | 4.3 | 6.4 | 9.4 |
| POST complete | 1960 | 10.3 | 14 | 17.5 |
| POST save details | 215 | 4.6 | 7.8 | 10.1 |

Run on one machine (4 vCPU): API with in-process worker (2 concurrent jobs), Postgres 16, Garage as the bucket, and the load generator. CI reruns a compressed version (500 teams in 2 minutes) on every push and uploads the report as an artifact.

## Why 64 KB files and not 100 MB

2,000 × 100 MB = 200 GB, 20× the free storage tier. The design makes the size irrelevant to the API: file bytes go from the browser to the bucket over signed URLs and never pass through the API, so API latency is the same for a 64 KB file and a 100 MB one. The 100 MB path itself (10 parts, resume, hashing) is exercised in the browser and by the multi-part tests.

## Run it

```bash
cd server
npm run seed -- --teams 2000 --deadline-minutes 10 --tokens ../loadtest/tokens.json
npm run loadtest -- --base http://localhost:3000 --tokens ../loadtest/tokens.json --out ../loadtest/results/run.json
npx tsx scripts/report.ts ../loadtest/results/run.json
```

The server needs `RATE_GLOBAL_PER_IP` raised for the run, because every simulated team comes from one IP.
