import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, fixture, startHarness, tinyPdf, uploadFile, waitForJobs, type Harness } from './helpers.js';

/**
 * "Exactly once" here means exactly-once *effect*: a job may run more than
 * once (that is unavoidable when a worker can die at any instant), but its
 * results are recorded once. These tests run real worker processes and kill
 * them with SIGKILL, so nothing gets a chance to clean up.
 */

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const children = new Set<ChildProcess>();
afterAll(() => children.forEach((c) => c.kill('SIGKILL')));

function startWorker(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
    env: { ...process.env, JOB_LEASE_SECONDS: '2', JOB_POLL_MS: '50', WORKER_CONCURRENCY: '1', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  children.add(child);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  return { child, exited, log: () => log };
}

async function until(fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

/** Invariants that must hold for every version, whatever crashed when. */
async function assertExactlyOnce(versionIds: string[]) {
  const { rows } = await h.pool.query(
    `SELECT v.id, v.status, j.status AS job_status, j.attempts,
            (SELECT count(*)::int FROM check_results c WHERE c.version_id = v.id) AS results,
            (SELECT count(DISTINCT c.job_id || ':' || c.attempt)::int FROM check_results c WHERE c.version_id = v.id) AS attempts_that_wrote,
            (SELECT count(*)::int FROM receipts r WHERE r.version_id = v.id) AS receipts
       FROM versions v JOIN jobs j ON j.version_id = v.id WHERE v.id = ANY($1)`,
    [versionIds],
  );
  expect(rows).toHaveLength(versionIds.length);
  for (const r of rows) {
    expect(r.job_status).toBe('done');
    expect(r.status).toBe('accepted');
    expect(r.attempts_that_wrote).toBe(1); // all results come from one single attempt
    expect(r.results).toBe(3); // integrity, file_type, preview
    expect(r.receipts).toBe(1);
  }
  return rows;
}

async function makeVersions(n: number) {
  // Jobs left over by other test files would be claimed first; park them so
  // each test controls exactly which jobs exist.
  await h.pool.query("UPDATE jobs SET status = 'dead', last_error = 'parked by test' WHERE status IN ('queued', 'running')");
  const f = await fixture(h.pool);
  const call = api(h.baseUrl, f.token);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { complete } = await uploadFile(call, f.teamId, tinyPdf());
    ids.push(complete.body.id);
  }
  return ids;
}

describe('exactly-once job effects', () => {
  it('a worker SIGKILLed right before committing is retried by another worker with no duplicate results', async () => {
    const [versionId] = await makeVersions(1);
    const doomed = startWorker({ WORKER_FAULT: 'crash:before_commit' });
    const { signal } = await doomed.exited;
    expect(signal).toBe('SIGKILL');
    // The crash left the job claimed (running, attempt 1) and wrote nothing.
    const mid = await h.pool.query('SELECT status, attempts FROM jobs WHERE version_id = $1', [versionId]);
    expect(mid.rows[0]).toMatchObject({ status: 'running', attempts: 1 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM check_results WHERE version_id = $1', [versionId])).rows[0].n).toBe(0);

    const healthy = startWorker();
    await until(async () => (await h.pool.query("SELECT 1 FROM jobs WHERE version_id = $1 AND status = 'done'", [versionId])).rowCount === 1);
    healthy.child.kill('SIGTERM');
    const [row] = await assertExactlyOnce([versionId!]);
    expect(row.attempts).toBe(2);
  });

  it('a hung worker that wakes up after its lease was taken over cannot write (fencing token)', async () => {
    const [versionId] = await makeVersions(1);
    const zombie = startWorker({ WORKER_FAULT: 'stall:before_commit', WORKER_STALL_MS: '5000' });
    await until(async () => (await h.pool.query("SELECT 1 FROM jobs WHERE version_id = $1 AND status = 'running'", [versionId])).rowCount === 1);
    const healthy = startWorker();
    await until(async () => (await h.pool.query("SELECT 1 FROM jobs WHERE version_id = $1 AND status = 'done'", [versionId])).rowCount === 1);
    // Let the zombie wake up and try to commit its stale result.
    await until(async () => zombie.log().includes('lease lost'), 15_000);
    zombie.child.kill('SIGKILL');
    healthy.child.kill('SIGTERM');
    const [row] = await assertExactlyOnce([versionId!]);
    expect(row.attempts).toBe(2);
  });

  it('kill storm: workers are SIGKILLed at random while 15 jobs run; every job ends with exactly one result set', async () => {
    const ids = await makeVersions(15);
    let kills = 0;
    for (let round = 0; round < 6; round++) {
      const ws = [startWorker({ WORKER_SLOW_MS: '300' }), startWorker({ WORKER_SLOW_MS: '300' })];
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
      for (const w of ws) {
        w.child.kill('SIGKILL');
        kills++;
      }
      await Promise.all(ws.map((w) => w.exited));
    }
    const finisher = startWorker();
    await waitForJobs(h.pool, 40_000);
    finisher.child.kill('SIGTERM');
    const rows = await assertExactlyOnce(ids);
    const retried = rows.filter((r) => r.attempts > 1).length;
    expect(kills).toBe(12);
    // At least one kill must have landed mid-job, or this test proves nothing.
    expect(retried).toBeGreaterThan(0);
    console.log(`kill storm: ${kills} SIGKILLs, ${retried}/${ids.length} jobs ran more than once, 0 duplicate results`);
  });
});
