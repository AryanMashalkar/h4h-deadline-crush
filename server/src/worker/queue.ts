import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Tx } from '../db.js';

export interface Job {
  id: number;
  kind: string;
  version_id: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

/**
 * Claims the oldest runnable job: a queued job whose time has come, or a
 * running job whose lease expired (its worker died or hung). SKIP LOCKED lets
 * many workers claim in parallel without waiting on each other. Every claim
 * gets a fresh lease_token, which acts as a fencing token: only the holder of
 * the current token can write results.
 */
export async function claim(pool: pg.Pool, workerId: string, leaseSeconds: number): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `UPDATE jobs j
        SET status = 'running', attempts = j.attempts + 1, lease_token = $2,
            lease_until = clock_timestamp() + make_interval(secs => $3), locked_by = $1
      WHERE j.id = (
        SELECT id FROM jobs
         WHERE (status = 'queued' AND run_after <= clock_timestamp())
            OR (status = 'running' AND lease_until < clock_timestamp())
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING j.id, j.kind, j.version_id, j.attempts, j.max_attempts, j.lease_token`,
    [workerId, randomUUID(), leaseSeconds],
  );
  return rows[0] ?? null;
}

/** Extends the lease. Returns false if another worker has taken the job over. */
export async function heartbeat(pool: pg.Pool, job: Job, leaseSeconds: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET lease_until = clock_timestamp() + make_interval(secs => $3)
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, leaseSeconds],
  );
  return rowCount === 1;
}

export class LeaseLost extends Error {
  constructor() {
    super('lease lost: another worker owns this job now');
  }
}

/**
 * The fence. Called first inside the transaction that writes results: it
 * marks the job done only if we still hold the lease, and locks the job row
 * so a concurrent reclaim waits for us. If it fails, the transaction is
 * rolled back and nothing this attempt computed is written.
 */
export async function completeFenced(tx: Tx, job: Job): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE jobs SET status = 'done', finished_at = clock_timestamp(), lease_until = NULL, last_error = NULL
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token],
  );
  if (rowCount !== 1) throw new LeaseLost();
}

/** Puts the job back with exponential backoff, or marks it dead after max_attempts. */
export async function failJob(pool: pg.Pool, job: Job, error: string): Promise<'retry' | 'dead' | 'lost'> {
  const dead = job.attempts >= job.max_attempts;
  const { rowCount } = await pool.query(
    `UPDATE jobs
        SET status = $3, last_error = $4, lease_token = NULL, lease_until = NULL,
            run_after = clock_timestamp() + make_interval(secs => $5),
            finished_at = CASE WHEN $3 = 'dead' THEN clock_timestamp() END
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.id, job.lease_token, dead ? 'dead' : 'queued', error.slice(0, 1000), Math.min(60, 2 ** job.attempts)],
  );
  if (rowCount !== 1) return 'lost';
  return dead ? 'dead' : 'retry';
}
