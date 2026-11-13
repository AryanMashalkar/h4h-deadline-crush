import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Return bigint counts as numbers; our counts are small.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Hosted Postgres (Neon, Supabase, Render) needs TLS; local and CI do not. Certificates are verified. */
export function sslFor(url: string): boolean | undefined {
  return /sslmode=require|neon\.tech|supabase|render\.com/.test(url) ? true : undefined;
}

export function createPool(url = config.databaseUrl, max = config.dbPoolSize): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ssl: sslFor(url),
    statement_timeout: 10_000,
  });
  pool.on('error', () => {
    /* idle client errors are retried by the pool */
  });
  return pool;
}

/**
 * Runs fn inside a READ COMMITTED transaction. Correctness does not rely on a
 * stronger isolation level: every race is closed by a row lock taken through a
 * conditional UPDATE, or by a unique constraint.
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Locks are taken in one order (team row -> upload session -> version), so
  // deadlocks should not happen. If one ever does, Postgres aborts one side and
  // the whole transaction is re-run.
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTx(pool, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 3) continue;
      throw err;
    }
  }
}

async function runTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout = '5s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate(pool: pg.Pool, dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations')) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise concurrent migrators (several instances booting at once).
      await client.query('SELECT pg_advisory_xact_lock(7243001)');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount === 0) {
        await client.query(await readFile(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
