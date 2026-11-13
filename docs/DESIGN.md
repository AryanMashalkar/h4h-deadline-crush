# Design: submissions that survive the last 10 minutes

**Goal, in order:** nothing is lost, the deadline is fair, then everything else. One Node process (API + worker) on Postgres and S3-compatible storage. Postgres is the source of truth for every rule: the deadline check, version numbers, the job queue and the "one result per check" guarantee.

## 1. Upload flow

```
browser                         API (never sees file bytes)                  bucket (R2 / Garage)
1 SHA-256 the file locally
2 POST /uploads {size, sha256,  ── stamp started_at = DB clock, check window,
  title, links, clientKey}         capture details, CreateMultipartUpload ──▶
3 POST /parts [1..16]           ── sign UploadPart URLs (≤10 min, never past
                                   deadline + grace)
4 PUT part n ─────────────────────────────────────────────────────────────▶  stores part, returns ETag
5 POST /complete {parts}        ── CompleteMultipartUpload, HEAD size check, then ONE transaction:
                                   version row + job row + session=completed + NOTIFY
6 SSE: version.created → version.checked (accepted / needs_fix / rejected)
```

* **Resumable:** fixed 10 MiB parts, 4 in flight, each retried with backoff; the browser waits for `online` when the network drops. Part ETags are saved in `localStorage`, and `GET /parts` lists what the bucket already holds, so after a reload the user re-selects the file and only missing parts are sent.
* **Idempotent:** `clientKey` = hash of the file, so "start" twice returns the same session (unique `(team_id, client_key)`). "Complete" locks the session row; a second call returns the same version. If storage completed but our commit was lost, the retry finds the object with `HEAD` and carries on.
* The multipart ETag is not a content hash, so the worker computes SHA-256 itself while streaming the object; that hash is the receipt.

## 2. Deadline and grace policy

All times are the **database clock** (`clock_timestamp()`); the browser's clock is only used to draw the countdown. The rule is one SQL function, `submission_window()`, used by every write path:

| Action | Allowed when |
|---|---|
| Save details, start an upload | `now < deadline` (the deadline itself is already closed) |
| Get part URLs, complete an upload | `now < deadline`, **or** the upload started before the deadline and `now < deadline + grace` (default 15 min; 2 min in demos) |
| Anything else after that | refused with `403 DEADLINE_PASSED` and written to `late_attempts` |

* **Grace buys transfer time, not work time.** The SHA-256 and size are declared when the upload starts, i.e. before the deadline, and the details are captured then too. A file finished in grace whose bytes do not match the declared hash is **rejected** and does not count. Part URLs expire at `min(10 min, deadline + grace − now)`; after that, uploads still open are expired and aborted.
* **Which version counts:** every version is kept (append-only). Version numbers come from an atomic increment on the team row, so they are ordered by commit. The version that counts is the newest one that is not rejected (`counted_versions` view). Because no version can be created outside the window, "newest" is "last one before the deadline"; a grace-period file carries `effective_at = started_at`, which is before the deadline.
* Tested at the boundary in `test/deadline.test.ts`: 1 µs before / at / after the deadline, the last µs of grace, an upload started exactly at the deadline, grace = 0, and a client sending a fake earlier time.

## 3. Exactly-once checks

No queue can promise exactly-once *delivery* when a worker can die at any instant, so this system promises exactly-once **effect**: a job may run twice, its result is recorded once.

1. **Transactional outbox.** The job row is inserted in the same transaction as the version, so there is never a version without a job or the reverse.
2. **Claim with a lease.** `UPDATE jobs … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` takes the oldest queued job, or a running job whose lease expired. Each claim gets a fresh `lease_token`. Workers heartbeat every lease/3.
3. **Fenced commit.** All results go in one transaction that starts with `UPDATE jobs SET status='done' WHERE id=$1 AND lease_token=$2 AND status='running'`. If a worker hung, lost its lease and another worker finished the job, this matches 0 rows and the whole transaction rolls back: the zombie writes nothing.
4. **Second guard:** `check_results` has primary key `(version_id, check_name)` and `receipts` has `version_id`, so even a bug in step 3 cannot produce a duplicate row.
5. Side effects outside Postgres are idempotent by key: the preview PNG is written to `previews/<version>.png`, so a re-run overwrites the same object.

**Proof** (`test/exactly-once.test.ts`, real worker processes): a worker that `SIGKILL`s itself just before committing is retried by a second worker (attempts = 2, one result set); a worker that hangs past its lease and wakes up after another worker committed is fenced out; and a **kill storm** runs 15 jobs while workers are `SIGKILL`ed at random 12 times, then checks every version has exactly one result set from exactly one attempt. A typical run: 9 of 15 jobs ran more than once, 0 duplicates. The same demo works by hand: `docker compose kill -s SIGKILL worker-1`.

## 4. Checks (and their own safety)

* **Type by content**, never by extension (`file-type` magic bytes); allowed: PDF, ZIP, PNG, JPEG, MP4, WebM.
* **Zip bombs:** only the central directory is read; the archive is never extracted. Limits: 10,000 entries, 1 GiB total declared size, 100:1 ratio per entry over 1 MiB; `../` and absolute paths are refused. Only the top-most README is inflated, capped at 64 KB, and `yauzl` verifies actual inflated sizes against the headers.
* **Links (SSRF):** http/https on ports 80/443 only, no credentials, at most 3 redirects with every hop re-checked. Every resolved address must be public unicast (no loopback, RFC 1918, link-local such as `169.254.169.254`, CGNAT, IPv4-mapped IPv6…), and the connection is made to the address that was checked (custom DNS lookup), so DNS rebinding does not help.
* **PDF preview:** `pdftoppm` renders page 1 in a child process with a 20 s kill timeout, so a hostile PDF can only hurt that process.

## 5. Nothing lost: proof under load

`npm run loadtest` is an open-model test (like k6 `ramping-arrival-rate`): 2,000 teams on a schedule that is back-loaded toward the deadline (cumulative share (t/T)³, about 27% in the last minute), ~10% also save a second version, ~2% try after the deadline. Afterwards it (a) runs the organizer **reconciliation** (`HEAD` every object every version points at, plus completed-upload → version → job links) and (b) checks, team by team, that the SHA-256 the worker computed from the bucket equals the SHA-256 the client computed before uploading. Results are in [`loadtest/results`](../loadtest/results).

## Security

JWT auth; team pages, files and events are visible only to members (a non-member gets the same 404 as a missing team, so IDs cannot be probed); organizers can read but never submit; demo organizers are scoped to their own demo hackathon. Download and part URLs are signed and short-lived. Every input is validated with zod (sizes, hashes, file names, link schemes, part lists); per-IP rate limits; CSV export neutralises spreadsheet formulas.

## Trade-offs

* **Postgres as the queue** instead of Redis/BullMQ: one less service on a free tier, transactional enqueue, and the fence lives next to the data. Cost: polling (`SKIP LOCKED` on a partial index, 500 ms); at much larger scale I would add `LISTEN` wake-ups or move to a dedicated queue.
* **Worker in the API process** on the free tier (one instance). It can run separately (`npm run start:worker`, two in Docker Compose); the design does not change.
* **The load test uses 64 KB files**, not 100 MB: 2,000 × 100 MB is 200 GB, 20× the R2 free tier. Because bytes never touch the API, API latency does not depend on file size; the 100 MB path is shown separately in the browser and in tests with multi-part files.
* **Hashing in the browser** costs ~1 s per 100 MB before the upload starts. It is what makes grace fair, so I kept it.
* **Rate limits and SSE fan-out are per instance.** Events go through `pg_notify`, so more instances work; limits would move to Redis.

## With one more week

Emailed receipts (an outbox row in the same transaction, sent with an idempotency key); ClamAV as one more pluggable check on a bigger worker; a status page; property-based tests that interleave uploads, edits and the deadline at random; a full-size 100 MB data-plane run on paid storage; Playwright tests for offline resume.
