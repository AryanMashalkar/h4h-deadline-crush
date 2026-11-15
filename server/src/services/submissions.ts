import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { z } from 'zod';
import { config } from '../config.js';
import { withTx, type Tx } from '../db.js';
import { AppError, PG, conflict, forbidden, notFound, pgCode } from '../errors.js';
import { publish } from '../events.js';
import type { Storage } from '../storage.js';
import type * as V from '../validation.js';

export interface Actor {
  userId: string;
  role: 'participant' | 'organizer';
}

interface TeamRow {
  id: string;
  hackathon_id: string;
  name: string;
  deadline: Date;
  grace_seconds: number;
  max_file_bytes: string | number;
}

/** Loads the team and checks the actor is a member. Organizers may read any team but never write. */
export async function teamFor(db: pg.Pool | Tx, actor: Actor, teamId: string, mode: 'read' | 'write'): Promise<TeamRow> {
  const { rows } = await db.query<TeamRow & { is_member: boolean; is_organizer: boolean }>(
    `SELECT t.id, t.hackathon_id, t.name, h.deadline, h.grace_seconds, h.max_file_bytes,
            EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) AS is_member,
            EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role = 'organizer'
                       AND (u.organizer_of IS NULL OR u.organizer_of = t.hackathon_id)) AS is_organizer
       FROM teams t JOIN hackathons h ON h.id = t.hackathon_id
      WHERE t.id = $1`,
    [teamId, actor.userId],
  );
  const team = rows[0];
  // Same answer for "no such team" and "not your team": ids cannot be probed.
  if (!team) throw notFound('Team');
  if (!team.is_member && !(mode === 'read' && team.is_organizer)) throw notFound('Team');
  return team;
}

export class DeadlineError extends AppError {}

async function recordLate(pool: pg.Pool, hackathonId: string, teamId: string, userId: string, action: string) {
  await pool.query('INSERT INTO late_attempts (hackathon_id, team_id, user_id, action) VALUES ($1, $2, $3, $4)', [
    hackathonId,
    teamId,
    userId,
    action,
  ]);
  await publish(pool, { type: 'late.attempt', hackathonId, teamId });
}

function deadlineClosed(team: { deadline: Date; grace_seconds: number }, what: string) {
  return new DeadlineError(403, 'DEADLINE_PASSED', `${what}: the deadline has passed`, {
    deadline: team.deadline.toISOString(),
    graceSeconds: team.grace_seconds,
  });
}

/** Runs a mutation; if it was refused because of the deadline, the refusal is logged for organizers. */
async function guardLate<T>(pool: pg.Pool, team: TeamRow, actor: Actor, action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DeadlineError) await recordLate(pool, team.hackathon_id, team.id, actor.userId, action);
    throw err;
  }
}

// --------------------------------------------------------------------- uploads

export interface UploadSessionView {
  id: string;
  status: string;
  fileName: string;
  size: number;
  partSize: number;
  partCount: number;
  startedAt: string;
  /** Last moment the upload may finish: deadline + grace if it started before the deadline. */
  finishBy: string;
}

function sessionView(row: Record<string, any>, team: { deadline: Date; grace_seconds: number }): UploadSessionView {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    size: Number(row.declared_size),
    partSize: row.part_size,
    partCount: row.part_count,
    startedAt: new Date(row.started_at).toISOString(),
    finishBy: new Date(team.deadline.getTime() + team.grace_seconds * 1000).toISOString(),
  };
}

export async function startUpload(
  pool: pg.Pool,
  storage: Storage,
  actor: Actor,
  teamId: string,
  input: z.infer<typeof V.startUpload>,
): Promise<{ created: boolean; session: UploadSessionView }> {
  const team = await teamFor(pool, actor, teamId, 'write');
  const existing = await pool.query('SELECT * FROM upload_sessions WHERE team_id = $1 AND client_key = $2', [teamId, input.clientKey]);
  if (existing.rows[0]) return { created: false, session: sessionView(existing.rows[0], team) };

  if (input.size > Number(team.max_file_bytes)) {
    throw new AppError(413, 'FILE_TOO_LARGE', `Files may be at most ${Number(team.max_file_bytes)} bytes`);
  }
  const partSize = config.partSize;
  const partCount = Math.max(1, Math.ceil(input.size / partSize));
  const id = randomUUID();
  const objectKey = `uploads/${team.hackathon_id}/${teamId}/${id}`;

  return guardLate(pool, team, actor, 'start_upload', async () => {
    try {
      return await withTx(pool, async (tx) => {
        // Serialise uploads of one team so the open-upload cap holds under concurrency.
        await tx.query('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
        const open = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM upload_sessions WHERE team_id = $1 AND status = 'open'",
          [teamId],
        );
        if (open.rows[0]!.n >= config.maxOpenUploadsPerTeam) {
          throw conflict('TOO_MANY_UPLOADS', 'Finish or cancel an upload in progress first');
        }
        // The window check and started_at come from the same database clock reading.
        const ins = await tx.query(
          `WITH c AS (SELECT clock_timestamp() AS t)
           INSERT INTO upload_sessions (id, team_id, hackathon_id, created_by, client_key, file_name, content_type,
                                        declared_size, declared_sha256, part_size, part_count, title, description, links,
                                        object_key, started_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, c.t
             FROM c, hackathons h
            WHERE h.id = $3 AND submission_window(h.deadline, h.grace_seconds, 'start', NULL, c.t) = 'open'
           RETURNING *`,
          [id, teamId, team.hackathon_id, actor.userId, input.clientKey, input.fileName, input.contentType, input.size,
           input.sha256, partSize, partCount, input.title, input.description, JSON.stringify(input.links), objectKey],
        );
        if (!ins.rows[0]) throw deadlineClosed(team, 'Cannot start an upload');
        const uploadId = await storage.createMultipart(objectKey, input.contentType);
        const row = (await tx.query('UPDATE upload_sessions SET s3_upload_id = $2 WHERE id = $1 RETURNING *', [id, uploadId])).rows[0];
        await publish(tx, { type: 'upload.started', hackathonId: team.hackathon_id, teamId, uploadId: id });
        return { created: true, session: sessionView(row, team) };
      });
    } catch (err) {
      // A retry raced the first attempt: return what the first attempt created.
      if (pgCode(err) === PG.uniqueViolation) {
        const again = await pool.query('SELECT * FROM upload_sessions WHERE team_id = $1 AND client_key = $2', [teamId, input.clientKey]);
        if (again.rows[0]) return { created: false, session: sessionView(again.rows[0], team) };
      }
      throw err;
    }
  });
}

interface SessionRow {
  id: string;
  team_id: string;
  status: string;
  object_key: string;
  s3_upload_id: string | null;
  part_count: number;
  part_size: number;
  declared_size: string;
  window: 'open' | 'grace' | 'closed';
  seconds_left: number;
}

async function loadSession(db: pg.Pool | Tx, teamId: string, sessionId: string, lock = false): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.*, submission_window(h.deadline, h.grace_seconds, 'transfer', s.started_at, clock_timestamp()) AS window,
            floor(extract(epoch FROM (h.deadline + make_interval(secs => h.grace_seconds)) - clock_timestamp()))::int AS seconds_left
       FROM upload_sessions s JOIN hackathons h ON h.id = s.hackathon_id
      WHERE s.id = $1 AND s.team_id = $2 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [sessionId, teamId],
  );
  if (!rows[0]) throw notFound('Upload');
  return rows[0];
}

/** Short-lived URLs for uploading parts. Refused once the upload's window has closed. */
export async function signParts(pool: pg.Pool, storage: Storage, actor: Actor, teamId: string, sessionId: string, partNumbers: number[]) {
  const team = await teamFor(pool, actor, teamId, 'write');
  return guardLate(pool, team, actor, 'sign_parts', async () => {
    const s = await loadSession(pool, teamId, sessionId);
    if (s.status !== 'open') throw conflict('UPLOAD_NOT_OPEN', `This upload is ${s.status}`);
    if (s.window === 'closed') throw deadlineClosed(team, 'Cannot upload');
    for (const n of partNumbers) if (n > s.part_count) throw new AppError(400, 'BAD_PART', `Part ${n} is out of range`);
    // A URL never outlives the window, so a leaked URL is useless after deadline + grace.
    const expiresIn = Math.max(1, Math.min(config.partUrlTtlSeconds, s.seconds_left));
    const urls = await Promise.all(
      partNumbers.map(async (n) => ({ partNumber: n, url: await storage.signPart(s.object_key, s.s3_upload_id!, n, expiresIn) })),
    );
    return { expiresIn, window: s.window, urls };
  });
}

/** Parts already stored, so a client that lost its state can resume where it stopped. */
export async function listUploadedParts(pool: pg.Pool, storage: Storage, actor: Actor, teamId: string, sessionId: string) {
  await teamFor(pool, actor, teamId, 'write');
  const s = await loadSession(pool, teamId, sessionId);
  if (s.status !== 'open') return { status: s.status, parts: [] };
  return { status: s.status, parts: await storage.listParts(s.object_key, s.s3_upload_id!) };
}

export async function abortUpload(pool: pg.Pool, storage: Storage, actor: Actor, teamId: string, sessionId: string) {
  const team = await teamFor(pool, actor, teamId, 'write');
  const s = await withTx(pool, async (tx) => {
    const s = await loadSession(tx, teamId, sessionId, true);
    if (s.status !== 'open') return s;
    await tx.query("UPDATE upload_sessions SET status = 'aborted' WHERE id = $1", [sessionId]);
    await publish(tx, { type: 'upload.aborted', hackathonId: team.hackathon_id, teamId, uploadId: sessionId });
    return s;
  });
  if (s.s3_upload_id) await storage.abortMultipart(s.object_key, s.s3_upload_id);
  return { status: 'aborted' };
}

/**
 * Finishes an upload and creates a version. Idempotent: completing twice
 * (double click, retry after a lost response) returns the same version.
 */
export async function completeUpload(
  pool: pg.Pool,
  storage: Storage,
  actor: Actor,
  teamId: string,
  sessionId: string,
  parts: { partNumber: number; etag: string }[],
) {
  const team = await teamFor(pool, actor, teamId, 'write');
  return guardLate(pool, team, actor, 'complete_upload', () =>
    withTx(pool, async (tx) => {
      const s = await loadSession(tx, teamId, sessionId, true);
      if (s.status === 'completed') {
        const v = await tx.query('SELECT id FROM versions WHERE upload_session_id = $1', [sessionId]);
        return { replayed: true, version: await getVersion(tx, v.rows[0].id) };
      }
      if (s.status !== 'open') throw conflict('UPLOAD_NOT_OPEN', `This upload is ${s.status}`);
      if (s.window === 'closed') throw deadlineClosed(team, 'Cannot complete the upload');

      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      if (sorted.length !== s.part_count || sorted.some((p, i) => p.partNumber !== i + 1)) {
        throw new AppError(400, 'BAD_PARTS', `Expected parts 1..${s.part_count}`);
      }
      try {
        await storage.completeMultipart(s.object_key, s.s3_upload_id!, sorted);
      } catch (err) {
        // A previous attempt may have completed in storage and then lost its DB
        // commit; the object then exists and we carry on.
        if ((await storage.head(s.object_key)) === null) {
          throw new AppError(400, 'UPLOAD_INCOMPLETE', 'Storage refused to assemble the parts; re-upload missing parts and retry', {
            cause: (err as Error).name,
          });
        }
      }
      const size = await storage.head(s.object_key);
      if (size !== Number(s.declared_size)) {
        await tx.query("UPDATE upload_sessions SET status = 'aborted' WHERE id = $1", [sessionId]);
        await storage.delete(s.object_key).catch(() => {});
        // Commit the abort, then report the problem.
        return { error: new AppError(422, 'SIZE_MISMATCH', `Uploaded ${size} bytes but ${s.declared_size} were declared`) };
      }

      const version = await insertVersion(tx, {
        teamId,
        hackathonId: team.hackathon_id,
        actorId: actor.userId,
        clientKey: `upload:${sessionId}`,
        fromSessionId: sessionId,
      });
      await tx.query("UPDATE upload_sessions SET status = 'completed', completed_at = clock_timestamp() WHERE id = $1", [sessionId]);
      await publish(tx, { type: 'upload.completed', hackathonId: team.hackathon_id, teamId, uploadId: sessionId });
      return { replayed: false, version };
    }).then((r) => {
      if ('error' in r && r.error) throw r.error;
      return r as { replayed: boolean; version: VersionView };
    }),
  );
}

/** Saves new project details as a new version that keeps the latest file. Only before the deadline. */
export async function saveDetails(pool: pg.Pool, actor: Actor, teamId: string, input: z.infer<typeof V.saveDetails>) {
  const team = await teamFor(pool, actor, teamId, 'write');
  const prior = await pool.query('SELECT id FROM versions WHERE team_id = $1 AND client_key = $2', [teamId, input.clientKey]);
  if (prior.rows[0]) return { replayed: true, version: await getVersion(pool, prior.rows[0].id) };
  return guardLate(pool, team, actor, 'save_details', async () => {
    try {
      return await withTx(pool, async (tx) => ({
        replayed: false,
        version: await insertVersion(tx, {
          teamId,
          hackathonId: team.hackathon_id,
          actorId: actor.userId,
          clientKey: input.clientKey,
          details: input,
          team,
        }),
      }));
    } catch (err) {
      if (pgCode(err) === PG.uniqueViolation) {
        const again = await pool.query('SELECT id FROM versions WHERE team_id = $1 AND client_key = $2', [teamId, input.clientKey]);
        if (again.rows[0]) return { replayed: true, version: await getVersion(pool, again.rows[0].id) };
      }
      throw err;
    }
  });
}

/**
 * Creates the version row, numbers it, and enqueues its checks in the same
 * transaction (a transactional outbox): a version without a job, or a job
 * without a version, cannot exist.
 */
async function insertVersion(
  tx: Tx,
  a: {
    teamId: string;
    hackathonId: string;
    actorId: string;
    clientKey: string;
    fromSessionId?: string;
    details?: z.infer<typeof V.details>;
    team?: TeamRow;
  },
): Promise<VersionView> {
  // Atomic increment = row lock on the team: version numbers are gap-free and ordered by commit.
  const seq = await tx.query<{ version_seq: number }>('UPDATE teams SET version_seq = version_seq + 1 WHERE id = $1 RETURNING version_seq', [
    a.teamId,
  ]);
  const versionNo = seq.rows[0]!.version_seq;
  let row;
  if (a.fromSessionId) {
    // File upload: details were captured when the upload started; effective time = start time.
    row = await tx.query(
      `INSERT INTO versions (team_id, hackathon_id, version_no, created_by, client_key, title, description, links,
                             upload_session_id, object_key, file_name, file_size, declared_sha256, effective_at, in_grace)
       SELECT s.team_id, s.hackathon_id, $2, $3, $4, s.title, s.description, s.links,
              s.id, s.object_key, s.file_name, s.declared_size, s.declared_sha256, s.started_at,
              clock_timestamp() >= h.deadline
         FROM upload_sessions s JOIN hackathons h ON h.id = s.hackathon_id
        WHERE s.id = $1
       RETURNING id`,
      [a.fromSessionId, versionNo, a.actorId, a.clientKey],
    );
  } else {
    // Details edit: keeps the newest file; allowed only while the window is open.
    row = await tx.query(
      `WITH c AS (SELECT clock_timestamp() AS t),
            prev AS (SELECT object_key, file_name, file_size, declared_sha256 FROM versions
                      WHERE team_id = $1 AND object_key IS NOT NULL AND status <> 'rejected'
                      ORDER BY version_no DESC LIMIT 1)
       INSERT INTO versions (team_id, hackathon_id, version_no, created_by, client_key, title, description, links,
                             object_key, file_name, file_size, declared_sha256, effective_at, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, prev.object_key, prev.file_name, prev.file_size, prev.declared_sha256, c.t, c.t
         FROM c CROSS JOIN hackathons h LEFT JOIN prev ON true
        WHERE h.id = $2 AND submission_window(h.deadline, h.grace_seconds, 'start', NULL, c.t) = 'open'
       RETURNING id`,
      [a.teamId, a.hackathonId, versionNo, a.actorId, a.clientKey, a.details!.title, a.details!.description, JSON.stringify(a.details!.links)],
    );
    if (!row.rows[0]) throw deadlineClosed(a.team!, 'Cannot save changes');
  }
  const versionId: string = row.rows[0].id;
  await tx.query("INSERT INTO jobs (kind, version_id) VALUES ('check', $1)", [versionId]);
  await publish(tx, { type: 'version.created', hackathonId: a.hackathonId, teamId: a.teamId, versionId, status: 'checking' });
  return getVersion(tx, versionId);
}

// ----------------------------------------------------------------------- reads

export interface VersionView {
  id: string;
  versionNo: number;
  title: string;
  description: string;
  links: string[];
  file: { name: string; size: number; declaredSha256: string } | null;
  effectiveAt: string;
  createdAt: string;
  inGrace: boolean;
  status: string;
  statusReason: string | null;
  sha256: string | null;
  detectedType: string | null;
  hasPreview: boolean;
  previewText: string | null;
  checks: { name: string; ok: boolean; detail: unknown }[];
  createdBy: string;
}

export async function getVersion(db: pg.Pool | Tx, id: string): Promise<VersionView> {
  const { rows } = await db.query(
    `SELECT v.*, u.name AS author,
            COALESCE((SELECT json_agg(json_build_object('name', c.check_name, 'ok', c.ok, 'detail', c.detail) ORDER BY c.check_name)
                        FROM check_results c WHERE c.version_id = v.id), '[]') AS checks
       FROM versions v JOIN users u ON u.id = v.created_by WHERE v.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Version');
  return toVersionView(rows[0]);
}

function toVersionView(r: Record<string, any>): VersionView {
  return {
    id: r.id,
    versionNo: r.version_no,
    title: r.title,
    description: r.description,
    links: r.links,
    file: r.object_key ? { name: r.file_name, size: Number(r.file_size), declaredSha256: r.declared_sha256 } : null,
    effectiveAt: new Date(r.effective_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    inGrace: r.in_grace,
    status: r.status,
    statusReason: r.status_reason,
    sha256: r.sha256,
    detectedType: r.detected_type,
    hasPreview: !!r.preview_key,
    previewText: r.preview_text,
    checks: r.checks ?? [],
    createdBy: r.author,
  };
}

export async function teamSubmission(pool: pg.Pool, actor: Actor, teamId: string) {
  const team = await teamFor(pool, actor, teamId, 'read');
  const [versions, uploads, counted, clock] = await Promise.all([
    pool.query(
      `SELECT v.*, u.name AS author,
              COALESCE((SELECT json_agg(json_build_object('name', c.check_name, 'ok', c.ok, 'detail', c.detail) ORDER BY c.check_name)
                          FROM check_results c WHERE c.version_id = v.id), '[]') AS checks
         FROM versions v JOIN users u ON u.id = v.created_by
        WHERE v.team_id = $1 ORDER BY v.version_no DESC`,
      [teamId],
    ),
    pool.query("SELECT * FROM upload_sessions WHERE team_id = $1 AND status = 'open' ORDER BY started_at", [teamId]),
    pool.query('SELECT id FROM counted_versions WHERE team_id = $1', [teamId]),
    pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'),
  ]);
  return {
    team: { id: team.id, name: team.name, hackathonId: team.hackathon_id },
    deadline: team.deadline.toISOString(),
    graceSeconds: team.grace_seconds,
    maxFileBytes: Number(team.max_file_bytes),
    serverTime: clock.rows[0]!.now.toISOString(),
    countedVersionId: counted.rows[0]?.id ?? null,
    uploads: uploads.rows.map((r) => sessionView(r, team)),
    versions: versions.rows.map(toVersionView),
  };
}

/** A short-lived download link for a version's file (team members and organizers only). */
export async function versionLink(pool: pg.Pool, storage: Storage, actor: Actor, versionId: string, what: 'file' | 'preview') {
  const { rows } = await pool.query('SELECT team_id, object_key, file_name, preview_key FROM versions WHERE id = $1', [versionId]);
  if (!rows[0]) throw notFound('Version');
  await teamFor(pool, actor, rows[0].team_id, 'read');
  const key = what === 'file' ? rows[0].object_key : rows[0].preview_key;
  if (!key) throw notFound(what === 'file' ? 'File' : 'Preview');
  const name = what === 'file' ? rows[0].file_name : 'preview.png';
  return { url: await storage.signDownload(key, name, config.downloadUrlTtlSeconds), expiresIn: config.downloadUrlTtlSeconds };
}

/** Builds the queued receipt email as an RFC 5322 message (CRLF line endings). */
export async function receiptEmail(pool: pg.Pool, actor: Actor, versionId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT v.team_id, e.to_addresses, e.subject, e.body, e.created_at, e.idempotency_key
       FROM versions v LEFT JOIN email_outbox e ON e.version_id = v.id WHERE v.id = $1`,
    [versionId],
  );
  if (!rows[0]) throw notFound('Version');
  await teamFor(pool, actor, rows[0].team_id, 'read');
  if (!rows[0].body) throw notFound('Receipt email');
  const e = rows[0];
  // Header values come from our own data, but strip CR/LF anyway (header injection).
  const h = (v: string) => v.replace(/[\r\n]+/g, ' ');
  return [
    `From: ${h(config.mail.from)}`,
    `To: ${h(e.to_addresses.join(', '))}`,
    `Subject: ${h(e.subject)}`,
    `Date: ${new Date(e.created_at).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${h(e.idempotency_key)}@deadline-crush>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    e.body,
    '',
  ].join('\r\n');
}

export async function requireOrganizer(pool: pg.Pool, actor: Actor, hackathonId: string) {
  const { rows } = await pool.query(
    "SELECT 1 FROM users WHERE id = $1 AND role = 'organizer' AND (organizer_of IS NULL OR organizer_of = $2)",
    [actor.userId, hackathonId],
  );
  if (actor.role !== 'organizer' || !rows[0]) throw forbidden('Organizers of this hackathon only');
}
