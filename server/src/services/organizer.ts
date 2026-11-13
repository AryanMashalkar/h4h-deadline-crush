import type pg from 'pg';
import { notFound } from '../errors.js';

export async function hackathonStats(pool: pg.Pool, hackathonId: string) {
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.deadline, h.grace_seconds, clock_timestamp() AS server_time,
       (SELECT count(*)::int FROM teams t WHERE t.hackathon_id = h.id) AS teams,
       (SELECT count(*)::int FROM counted_versions c WHERE c.hackathon_id = h.id) AS teams_submitted,
       (SELECT count(*)::int FROM counted_versions c WHERE c.hackathon_id = h.id AND c.status = 'accepted') AS accepted,
       (SELECT count(*)::int FROM counted_versions c WHERE c.hackathon_id = h.id AND c.status = 'checking') AS checking,
       (SELECT count(*)::int FROM counted_versions c WHERE c.hackathon_id = h.id AND c.status = 'needs_fix') AS needs_fix,
       (SELECT count(*)::int FROM versions v WHERE v.hackathon_id = h.id) AS versions,
       (SELECT count(*)::int FROM versions v WHERE v.hackathon_id = h.id AND v.status = 'rejected') AS rejected_versions,
       (SELECT count(*)::int FROM versions v WHERE v.hackathon_id = h.id AND v.in_grace) AS grace_versions,
       (SELECT count(*)::int FROM upload_sessions s WHERE s.hackathon_id = h.id AND s.status = 'open') AS uploads_in_progress,
       (SELECT count(*)::int FROM late_attempts l WHERE l.hackathon_id = h.id) AS late_attempts,
       (SELECT count(DISTINCT c.version_id)::int FROM check_results c JOIN versions v ON v.id = c.version_id
         WHERE v.hackathon_id = h.id AND NOT c.ok) AS versions_failed_checks,
       (SELECT json_object_agg(check_name, n) FROM (
          SELECT c.check_name, count(*)::int AS n FROM check_results c JOIN versions v ON v.id = c.version_id
           WHERE v.hackathon_id = h.id AND NOT c.ok GROUP BY c.check_name) f) AS failed_by_check,
       (SELECT json_build_object(
          'queued', count(*) FILTER (WHERE j.status = 'queued'),
          'running', count(*) FILTER (WHERE j.status = 'running'),
          'done', count(*) FILTER (WHERE j.status = 'done'),
          'dead', count(*) FILTER (WHERE j.status = 'dead'),
          'retried', count(*) FILTER (WHERE j.attempts > 1))
          FROM jobs j JOIN versions v ON v.id = j.version_id WHERE v.hackathon_id = h.id) AS jobs,
       (SELECT COALESCE(json_agg(json_build_object('minute', m, 'n', n) ORDER BY m), '[]') FROM (
          SELECT date_trunc('minute', v.created_at) AS m, count(*)::int AS n FROM versions v
           WHERE v.hackathon_id = h.id AND v.created_at > h.deadline - interval '30 minutes'
           GROUP BY 1) per_min) AS per_minute
     FROM hackathons h WHERE h.id = $1`,
    [hackathonId],
  );
  if (!rows[0]) throw notFound('Hackathon');
  const r = rows[0];
  return {
    hackathon: { id: r.id, name: r.name, deadline: r.deadline.toISOString(), graceSeconds: r.grace_seconds },
    serverTime: r.server_time.toISOString(),
    teams: r.teams,
    teamsSubmitted: r.teams_submitted,
    counted: { accepted: r.accepted, checking: r.checking, needsFix: r.needs_fix },
    versions: r.versions,
    rejectedVersions: r.rejected_versions,
    graceVersions: r.grace_versions,
    uploadsInProgress: r.uploads_in_progress,
    lateAttempts: r.late_attempts,
    versionsFailedChecks: r.versions_failed_checks,
    failedByCheck: r.failed_by_check ?? {},
    jobs: r.jobs,
    perMinute: r.per_minute,
  };
}

/** Neutralises spreadsheet formulas (CSV injection) and quotes every cell. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportCsv(pool: pg.Pool, hackathonId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT t.name AS team, t.id AS team_id,
            (SELECT string_agg(u.name, '; ' ORDER BY u.name) FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id) AS members,
            c.version_no, c.title, c.links, c.file_name, c.file_size, c.sha256, c.detected_type, c.status, c.status_reason,
            c.effective_at, c.created_at, c.in_grace,
            (SELECT count(*) FROM versions v WHERE v.team_id = t.id) AS version_count
       FROM teams t LEFT JOIN counted_versions c ON c.team_id = t.id
      WHERE t.hackathon_id = $1 ORDER BY t.name`,
    [hackathonId],
  );
  const header = ['team', 'team_id', 'members', 'counted_version', 'title', 'links', 'file_name', 'file_bytes', 'sha256', 'detected_type',
    'status', 'status_reason', 'submitted_at', 'saved_at', 'finished_in_grace', 'version_count'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [r.team, r.team_id, r.members, r.version_no, r.title, (r.links ?? []).join(' '), r.file_name, r.file_size, r.sha256, r.detected_type,
        r.status ?? 'no submission', r.status_reason, r.effective_at?.toISOString(), r.created_at?.toISOString(), r.in_grace, r.version_count]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
