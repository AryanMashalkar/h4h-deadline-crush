import type pg from 'pg';
import type { Storage } from './storage.js';

export interface ReconcileReport {
  checkedAt: string;
  versionsWithFile: number;
  distinctObjects: number;
  objectsFound: number;
  missing: { versionId: string; key: string }[];
  sizeMismatch: { versionId: string; key: string; expected: number; actual: number }[];
  completedUploadsWithoutVersion: number;
  versionsWithoutJob: number;
  unfinishedJobs: number;
  ok: boolean;
}

/**
 * "Nothing lost": every version that points at a file must have that object in
 * storage with the right size; every completed upload must have produced a
 * version; every version must have its check job; no job may be left unfinished.
 */
export async function reconcile(pool: pg.Pool, storage: Storage, hackathonId?: string, concurrency = 16): Promise<ReconcileReport> {
  const scope = hackathonId ? 'AND v.hackathon_id = $1' : '';
  const params = hackathonId ? [hackathonId] : [];
  const { rows } = await pool.query(
    `SELECT v.id, v.object_key, v.file_size FROM versions v WHERE v.object_key IS NOT NULL ${scope}`,
    params,
  );
  const byKey = new Map<string, { id: string; size: number }[]>();
  for (const r of rows) {
    const list = byKey.get(r.object_key) ?? [];
    list.push({ id: r.id, size: Number(r.file_size) });
    byKey.set(r.object_key, list);
  }
  const report: ReconcileReport = {
    checkedAt: new Date().toISOString(),
    versionsWithFile: rows.length,
    distinctObjects: byKey.size,
    objectsFound: 0,
    missing: [],
    sizeMismatch: [],
    completedUploadsWithoutVersion: 0,
    versionsWithoutJob: 0,
    unfinishedJobs: 0,
    ok: false,
  };
  const keys = [...byKey.keys()];
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < keys.length) {
        const key = keys[i++]!;
        const size = await storage.head(key);
        for (const v of byKey.get(key)!) {
          if (size === null) report.missing.push({ versionId: v.id, key });
          else if (size !== v.size) report.sizeMismatch.push({ versionId: v.id, key, expected: v.size, actual: size });
        }
        if (size !== null) report.objectsFound++;
      }
    }),
  );
  const s = hackathonId ? 'AND hackathon_id = $1' : '';
  const extra = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM upload_sessions u WHERE u.status = 'completed' ${s.replace('hackathon_id', 'u.hackathon_id')}
           AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.upload_session_id = u.id)) AS orphans,
       (SELECT count(*)::int FROM versions v WHERE true ${scope} AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id)) AS no_job,
       (SELECT count(*)::int FROM jobs j JOIN versions v ON v.id = j.version_id WHERE j.status <> 'done' ${scope}) AS unfinished`,
    params,
  );
  report.completedUploadsWithoutVersion = extra.rows[0].orphans;
  report.versionsWithoutJob = extra.rows[0].no_job;
  report.unfinishedJobs = extra.rows[0].unfinished;
  report.ok =
    report.missing.length === 0 && report.sizeMismatch.length === 0 && report.completedUploadsWithoutVersion === 0 && report.versionsWithoutJob === 0;
  return report;
}
