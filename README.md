# Deadline Crush

**Hackathon submissions that survive the last 10 minutes.** 2,000 teams submit in the final minutes; nothing is lost, and the deadline is enforced fairly by the server.

Built for the Hack4Hack Crew Hiring Challenge 2026, problem statement 2.

* **Live:** https://deadline-crush.onrender.com (free tier: the first request after 15 idle minutes takes about 50 s while the instance wakes). Press **Start a demo**: you get a private hackathon whose deadline is 30 minutes away (or 2, 5, 10), movable from the organizer view, a team, and its organizer dashboard.
* **Design doc (1 page):** [docs/DESIGN.md](docs/DESIGN.md): upload flow, deadline and grace policy, how jobs stay exactly-once, trade-offs.
* **Load test report:** [loadtest/README.md](loadtest/README.md)

## What it does

| Must-have | How | Proof |
|---|---|---|
| Files up to 100 MB go straight to storage, resumable | S3 multipart with presigned part URLs (10 MiB parts). The API never streams a byte. Parts retry, uploads pause while offline, and resume after a reload | `test/upload.test.ts`, browser flow |
| Deadline on the server clock, written grace policy | One SQL function, `submission_window()`, on the DB clock. Uploads started before the deadline may finish within the grace period; the SHA-256 is declared before the deadline so grace buys transfer time, not work time | `test/deadline.test.ts` (µs boundaries) |
| Every version kept, last one before the deadline counts | Append-only `versions`, gap-free numbers from an atomic counter, `counted_versions` view | `test/deadline.test.ts` |
| Background checks | Postgres job queue (`SKIP LOCKED` + leases); type by magic bytes; zip-bomb and zip-slip limits without extracting; link checks with SSRF protection; PDF page-1 preview; README preview from ZIPs | `test/checks.test.ts` |
| Live status | Server-sent events fed by `pg_notify` inside each transaction: uploading → checking → accepted / needs a fix | `test/organizer.test.ts` |
| Exactly once | Transactional outbox + fenced commit (lease token) + unique keys | `test/exactly-once.test.ts` kills real worker processes with SIGKILL |
| Secure | JWT; members-only teams, files and events; short-lived signed URLs; zod on every input; rate limits | `test/security.test.ts` |
| Organizer dashboard | Live counts of submissions, late attempts, failed checks, queue health; CSV export; per-minute chart | `test/organizer.test.ts` |
| Load test | 2,000 teams in 10 minutes, open model, back-loaded; then a nothing-lost reconciliation (DB ↔ bucket, plus per-team SHA-256 match) | `loadtest/` |
| CI | 40+ tests including the kill tests, a compressed load test and a Docker build on every push | `.github/workflows/ci.yml` |

Bonus: SHA-256 receipt per accepted file, uploads that resume after going offline or reloading, a "nothing lost" check organizers can run (`GET /api/hackathons/:id/reconcile`).

## Run it

```bash
docker compose up --build        # Postgres, Garage (S3), API, two workers
open http://localhost:3000       # press "Start a demo"
docker compose kill -s SIGKILL worker-1   # kill a worker mid-job; worker-2 takes over
```

Without Docker for the app (Postgres 16 and an S3-compatible store needed):

```bash
./dev/garage-setup.sh > dev/.s3env && eval "$(cat dev/.s3env)"   # local Garage in Docker
cd server && npm ci && npm run dev                                 # API + in-process worker on :3000
cd web && npm ci && npm run dev                                    # UI on :5173
cd server && npm test                                              # needs DATABASE_URL to a scratch DB
```

## Layout

```
server/src/services/submissions.ts   uploads, versions, deadline enforcement
server/migrations/001_init.sql       schema + submission_window() policy function
server/src/worker/                   queue (claim / heartbeat / fence) and the worker
server/src/checks/                   archive, link (SSRF), PDF preview
server/src/reconcile.ts              nothing-lost check
server/scripts/loadtest.ts           2,000-team load test
web/src/upload.ts                    resumable browser uploader
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | local | Postgres 16 |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Garage on :3900 | Any S3-compatible store (Backblaze B2 or Cloudflare R2 in production) |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Host browsers use for signed URLs, if different |
| `PUBLIC_URL` | | Site origin, used for the bucket CORS rule set at boot |
| `JWT_SECRET` | dev only | 32+ characters in production |
| `WORKER_IN_PROCESS` | `true` | `false` to run workers separately (`npm run start:worker`) |
| `PART_URL_TTL_SECONDS` | `600` | Part URLs also never outlive deadline + grace |
