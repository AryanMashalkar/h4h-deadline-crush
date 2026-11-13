import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import type pg from 'pg';
import pino from 'pino';
import { inspectZip } from '../checks/archive.js';
import { checkLink } from '../checks/links.js';
import { renderPdfFirstPage } from '../checks/preview.js';
import { config } from '../config.js';
import { withTx } from '../db.js';
import { publish } from '../events.js';
import type { Storage } from '../storage.js';
import { claim, completeFenced, failJob, heartbeat, LeaseLost, type Job } from './queue.js';

/** File types a project may be submitted as, detected from content, never the extension. */
export const ALLOWED_TYPES = new Map([
  ['application/pdf', 'PDF'],
  ['application/zip', 'ZIP archive'],
  ['image/png', 'PNG image'],
  ['image/jpeg', 'JPEG image'],
  ['video/mp4', 'MP4 video'],
  ['video/webm', 'WebM video'],
]);

export interface CheckOutcome {
  status: 'accepted' | 'needs_fix' | 'rejected';
  reason: string | null;
  sha256: string | null;
  size: number | null;
  detectedType: string | null;
  previewKey: string | null;
  previewText: string | null;
  results: { name: string; ok: boolean; detail: Record<string, unknown> }[];
}

/**
 * Fault injection for the exactly-once tests. Set WORKER_FAULT to make the
 * worker SIGKILL itself, or hang past its lease, at a named point.
 */
const faultState = { heartbeatsPaused: false };

async function faultPoint(point: string, log: pino.Logger) {
  // Widens the window in which a kill lands mid-job (used by the kill-storm test).
  const slow = Number(process.env.WORKER_SLOW_MS ?? 0);
  if (slow > 0 && point === 'after_download') await new Promise((r) => setTimeout(r, slow));
  const fault = process.env.WORKER_FAULT;
  if (!fault) return;
  const [kind, at] = fault.split(':');
  if (at !== point) return;
  if (kind === 'crash') {
    log.warn({ point }, 'fault injection: SIGKILL');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {}); // never resumes
  }
  if (kind === 'stall') {
    const ms = Number(process.env.WORKER_STALL_MS ?? 8000);
    log.warn({ point, ms }, 'fault injection: stalling past the lease');
    // Behave like a hung process: no heartbeats while stalled.
    faultState.heartbeatsPaused = true;
    await new Promise((r) => setTimeout(r, ms));
  }
}

export async function runChecks(
  pool: pg.Pool,
  storage: Storage,
  versionId: string,
  log: pino.Logger,
  signal?: AbortSignal,
): Promise<CheckOutcome> {
  const v = (await pool.query('SELECT * FROM versions WHERE id = $1', [versionId])).rows[0];
  const max = Number((await pool.query('SELECT max_file_bytes FROM hackathons WHERE id = $1', [v.hackathon_id])).rows[0].max_file_bytes);
  const out: CheckOutcome = {
    status: 'accepted',
    reason: null,
    sha256: null,
    size: null,
    detectedType: null,
    previewKey: null,
    previewText: null,
    results: [],
  };
  const fixes: string[] = [];
  const add = (name: string, ok: boolean, detail: Record<string, unknown>, fix?: string) => {
    out.results.push({ name, ok, detail });
    if (!ok && fix) fixes.push(fix);
  };

  if (!v.object_key) {
    add('file', false, { error: 'no file uploaded yet' }, 'Upload your project file');
  } else {
    const dir = await mkdtemp(path.join(tmpdir(), 'crush-'));
    try {
      // 1. Stream the object to disk, hashing as it goes, and stop past the size limit.
      const file = path.join(dir, 'upload');
      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > max) return cb(new Error(`object is larger than ${max} bytes`));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(await storage.getStream(v.object_key), meter, createWriteStream(file), { signal });
      out.sha256 = hash.digest('hex');
      out.size = size;
      await faultPoint('after_download', log);

      // 2. Integrity: the bytes must be exactly what the team declared before the deadline.
      const intact = out.sha256 === v.declared_sha256 && size === Number(v.file_size);
      add('integrity', intact, { sha256: out.sha256, declaredSha256: v.declared_sha256, size, declaredSize: Number(v.file_size) });
      if (!intact) {
        out.status = 'rejected';
        out.reason = 'The uploaded file does not match the SHA-256 declared when the upload started';
      }

      // 3. Type by content (magic bytes).
      const ft = await fileTypeFromFile(file);
      out.detectedType = ft?.mime ?? 'unknown';
      const allowed = ft ? ALLOWED_TYPES.has(ft.mime) : false;
      const ext = path.extname(v.file_name ?? '').slice(1).toLowerCase();
      add(
        'file_type',
        allowed,
        { detected: out.detectedType, extension: ext, extensionMatches: ft ? ft.ext === ext || (ft.ext === 'jpg' && ext === 'jpeg') : false },
        `Upload a ${[...ALLOWED_TYPES.values()].join(', ')} (this file's content is ${out.detectedType})`,
      );

      // 4. Archives: bomb limits, unsafe paths, README preview.
      if (ft?.mime === 'application/zip') {
        const z = await inspectZip(file);
        add(
          'archive',
          z.ok,
          { entries: z.entries, totalUncompressed: z.totalUncompressed, maxRatio: z.maxRatio, nestedArchives: z.nestedArchives, error: z.reason },
          `Archive rejected: ${z.reason}`,
        );
        if (z.readme) out.previewText = z.readme.text;
      }

      // 5. PDF: render page 1. Deterministic key, so a retried job overwrites, never duplicates.
      if (ft?.mime === 'application/pdf') {
        const png = await renderPdfFirstPage(file, dir);
        if (png) {
          out.previewKey = `previews/${versionId}.png`;
          await storage.put(out.previewKey, png, 'image/png');
        }
        add('preview', true, { rendered: !!png });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 6. Links respond (with SSRF protection).
  const links: string[] = v.links ?? [];
  const linkResults = await Promise.all(
    links.map((u) => checkLink(u, { timeoutMs: config.worker.linkTimeoutMs, allowPrivate: config.worker.allowPrivateLinks })),
  );
  if (links.length > 0) {
    const bad = linkResults.filter((r) => !r.ok);
    add('links', bad.length === 0, { links: linkResults }, `Fix ${bad.length} link(s): ${bad.map((b) => `${b.url} (${b.error})`).join('; ')}`);
  }

  if (out.status !== 'rejected' && fixes.length > 0) {
    out.status = 'needs_fix';
    out.reason = fixes.join(' · ');
  }
  return out;
}

/**
 * Applies a job's outcome exactly once. Everything goes in one transaction
 * that starts with the fence: if this worker's lease was taken over, it
 * changes nothing. check_results' primary key is a second guard.
 */
export async function commitOutcome(pool: pg.Pool, job: Job, outcome: CheckOutcome) {
  await withTx(pool, async (tx) => {
    await completeFenced(tx, job);
    for (const r of outcome.results) {
      await tx.query(
        'INSERT INTO check_results (version_id, check_name, ok, detail, job_id, attempt) VALUES ($1, $2, $3, $4, $5, $6)',
        [job.version_id, r.name, r.ok, JSON.stringify(r.detail), job.id, job.attempts],
      );
    }
    const v = (
      await tx.query(
        `UPDATE versions SET status = $2, status_reason = $3, sha256 = $4, detected_type = $5, preview_key = $6,
                             preview_text = $7, checked_at = clock_timestamp()
          WHERE id = $1 RETURNING hackathon_id, team_id`,
        [job.version_id, outcome.status, outcome.reason, outcome.sha256, outcome.detectedType, outcome.previewKey, outcome.previewText],
      )
    ).rows[0];
    if (outcome.status === 'accepted' && outcome.sha256) {
      await tx.query('INSERT INTO receipts (version_id, sha256, size) VALUES ($1, $2, $3)', [job.version_id, outcome.sha256, outcome.size]);
    }
    await publish(tx, { type: 'version.checked', hackathonId: v.hackathon_id, teamId: v.team_id, versionId: job.version_id, status: outcome.status });
  });
}

export interface WorkerOptions {
  pool: pg.Pool;
  storage: Storage;
  concurrency?: number;
  leaseSeconds?: number;
  pollMs?: number;
  id?: string;
  logger?: pino.Logger;
}

export class Worker {
  readonly id: string;
  private running = false;
  private loops: Promise<void>[] = [];
  private maintenance?: NodeJS.Timeout;
  private log: pino.Logger;
  processed = 0;

  constructor(private readonly o: WorkerOptions) {
    this.id = o.id ?? `w-${process.pid}-${randomUUID().slice(0, 6)}`;
    this.log = (o.logger ?? pino({ level: config.logLevel })).child({ worker: this.id });
  }

  start() {
    this.running = true;
    for (let i = 0; i < (this.o.concurrency ?? config.worker.concurrency); i++) this.loops.push(this.loop());
    this.maintenance = setInterval(() => void expireUploads(this.o.pool, this.o.storage).catch(() => {}), 30_000);
    this.maintenance.unref();
  }

  async stop() {
    this.running = false;
    clearInterval(this.maintenance);
    await Promise.all(this.loops);
  }

  private async loop() {
    const lease = this.o.leaseSeconds ?? config.worker.leaseSeconds;
    while (this.running) {
      let job: Job | null = null;
      try {
        job = await claim(this.o.pool, this.id, lease);
      } catch (err) {
        this.log.error({ err }, 'claim failed');
      }
      if (!job) {
        await new Promise((r) => setTimeout(r, this.o.pollMs ?? config.worker.pollMs));
        continue;
      }
      await this.process(job, lease);
    }
  }

  async process(job: Job, lease: number) {
    const log = this.log.child({ job: job.id, version: job.version_id, attempt: job.attempts });
    if (job.attempts > job.max_attempts) {
      await this.giveUp(job, 'too many attempts (the worker kept dying on this job)');
      return;
    }
    const ac = new AbortController();
    const beat = setInterval(async () => {
      if (faultState.heartbeatsPaused) return;
      if (!(await heartbeat(this.o.pool, job, lease).catch(() => true))) ac.abort(new LeaseLost());
    }, Math.max(500, (lease * 1000) / 3));
    try {
      log.info('job started');
      const outcome = await runChecks(this.o.pool, this.o.storage, job.version_id, log, ac.signal);
      await faultPoint('before_commit', log);
      await commitOutcome(this.o.pool, job, outcome);
      this.processed++;
      log.info({ status: outcome.status }, 'job done');
    } catch (err) {
      if (err instanceof LeaseLost || ac.signal.aborted) {
        log.warn('lease lost; another worker owns this job, discarding my work');
        return;
      }
      const res = await failJob(this.o.pool, job, (err as Error).message).catch(() => 'lost');
      log.error({ err, res }, 'job failed');
      if (res === 'dead') await this.markVersionError(job);
    } finally {
      clearInterval(beat);
    }
  }

  private async giveUp(job: Job, why: string) {
    const res = await failJob(this.o.pool, { ...job, attempts: job.max_attempts }, why).catch(() => 'lost');
    if (res === 'dead') await this.markVersionError(job);
  }

  private async markVersionError(job: Job) {
    await withTx(this.o.pool, async (tx) => {
      const v = (
        await tx.query(
          `UPDATE versions SET status = 'needs_fix', status_reason = 'We could not check this file automatically; an organizer will review it',
                  checked_at = clock_timestamp() WHERE id = $1 AND status = 'checking' RETURNING hackathon_id, team_id`,
          [job.version_id],
        )
      ).rows[0];
      if (v) await publish(tx, { type: 'version.checked', hackathonId: v.hackathon_id, teamId: v.team_id, versionId: job.version_id, status: 'needs_fix' });
    });
  }
}

/** Uploads still open after deadline + grace can never finish: mark them expired and free the storage. */
export async function expireUploads(pool: pg.Pool, storage: Storage): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE upload_sessions s SET status = 'expired'
       FROM hackathons h
      WHERE h.id = s.hackathon_id AND s.status = 'open'
        AND submission_window(h.deadline, h.grace_seconds, 'transfer', s.started_at, clock_timestamp()) = 'closed'
      RETURNING s.object_key, s.s3_upload_id`,
  );
  for (const r of rows) if (r.s3_upload_id) await storage.abortMultipart(r.object_key, r.s3_upload_id);
  return rows.length;
}
