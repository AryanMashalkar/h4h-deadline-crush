import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { downloadFile, get, patch, post, type ApiError, type Stats } from '../api';
import { clock, when } from '../format';
import { useLive, useServerClock } from '../live';

interface Recon {
  ok: boolean;
  checkedAt: string;
  versionsWithFile: number;
  distinctObjects: number;
  objectsFound: number;
  missing: unknown[];
  sizeMismatch: unknown[];
  completedUploadsWithoutVersion: number;
  versionsWithoutJob: number;
  unfinishedJobs: number;
}

export function OrganizerPage() {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const prev = useRef<Stats | null>(null);
  const timer = useRef<number>();
  const [chaosNote, setChaosNote] = useState('');
  const [recon, setRecon] = useState<Recon | 'running' | { error: string } | null>(null);

  async function verify() {
    setRecon('running');
    try {
      setRecon(await get<Recon>(`/api/hackathons/${id}/reconcile`));
    } catch (err) {
      setRecon({ error: (err as ApiError).message ?? 'Check failed' });
    }
  }

  const load = useCallback(() => {
    get<Stats>(`/api/hackathons/${id}/stats`)
      .then((next) => {
        // Briefly highlight tiles whose number changed.
        const p = prev.current;
        if (p) {
          const changed: Record<string, number> = {};
          const pairs: [string, number, number][] = [
            ['submitted', p.teamsSubmitted, next.teamsSubmitted],
            ['late', p.lateAttempts, next.lateAttempts],
            ['failed', p.versionsFailedChecks, next.versionsFailedChecks],
            ['uploads', p.uploadsInProgress, next.uploadsInProgress],
            ['jobs', p.jobs.retried + p.jobs.fencedOut, next.jobs.retried + next.jobs.fencedOut],
          ];
          for (const [k, a, b] of pairs) if (a !== b) changed[k] = Date.now();
          setFlash((f) => ({ ...f, ...changed }));
        }
        prev.current = next;
        setS(next);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  // Live: coalesce bursts of events (2,000 teams in 10 minutes) into at most ~2 refreshes a second.
  const connected = useLive(
    `/api/hackathons/${id}/events`,
    () => {
      if (timer.current) return;
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        load();
      }, 500);
    },
    load,
  );
  // Also refresh every 10 s so the clock-driven numbers stay right.
  useEffect(() => {
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  const now = useServerClock(s?.serverTime);

  if (error && !s) return <p className="pad error" role="alert">{error}</p>;
  if (!s) return <p className="pad muted" role="status">Loading…</p>;

  const deadline = new Date(s.hackathon.deadline).getTime();
  const graceEnd = deadline + s.hackathon.graceSeconds * 1000;
  const phase = now < deadline ? 'open' : now < graceEnd ? 'grace' : 'closed';
  const maxPerMin = Math.max(1, ...s.perMinute.map((m) => m.n));

  async function exportCsv() {
    await downloadFile(`/api/hackathons/${id}/export.csv`, `submissions-${s!.hackathon.name.replace(/\W+/g, '-')}.csv`);
  }

  async function armChaos() {
    try {
      await post(`/api/hackathons/${id}/chaos`);
      setChaosNote('Armed. Upload a file as the team: its check will freeze and lose its lease.');
    } catch (e) {
      setChaosNote((e as ApiError).message);
    }
    load();
  }

  async function moveDeadline(minutesFromNow: number) {
    await patch(`/api/hackathons/${id}`, { deadline: new Date(now + minutesFromNow * 60_000).toISOString() });
    load();
  }

  const tile = (key: string, label: string, value: number | string, note?: string, tone?: string) => (
    <div className={`tile ${tone ?? ''} ${flash[key] && Date.now() - flash[key]! < 1200 ? 'flash' : ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );

  return (
    <div className="wrap org">
      <div className="team-head">
        <div>
          <p className="eyebrow">Organizer</p>
          <h1 tabIndex={-1}>{s.hackathon.name}</h1>
        </div>
        <span className={`live ${connected ? 'on' : ''}`} role="status">
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      <div className={`clock clock-${phase === 'open' ? (deadline - now < 600_000 ? 'soon' : 'open') : phase}`}>
        <div>
          <p className="eyebrow">{phase === 'open' ? 'Deadline in' : phase === 'grace' ? 'Grace period ends in' : 'Closed'}</p>
          <p className="clock-time">{phase === 'open' ? clock(deadline - now) : phase === 'grace' ? clock(graceEnd - now) : clock(0)}</p>
        </div>
        <dl className="clock-facts">
          <div>
            <dt>Deadline</dt>
            <dd>{when(s.hackathon.deadline)}</dd>
          </div>
          <div>
            <dt>Grace for started uploads</dt>
            <dd>{Math.round(s.hackathon.graceSeconds / 60)} min</dd>
          </div>
        </dl>
      </div>

      <section aria-label="Live counts" className="tiles">
        {tile('submitted', 'Teams submitted', `${s.teamsSubmitted} / ${s.teams}`, `${s.versions} versions in total`)}
        {tile('accepted', 'Accepted', s.counted.accepted, 'counted versions', 'good')}
        {tile('checking', 'Checking', s.counted.checking, `${s.jobs.queued} queued · ${s.jobs.running} running`)}
        {tile('failed', 'Failed checks', s.versionsFailedChecks, Object.entries(s.failedByCheck).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none', s.versionsFailedChecks ? 'warn' : '')}
        {tile('late', 'Late attempts', s.lateAttempts, 'refused by the server clock', s.lateAttempts ? 'bad' : '')}
        {tile('uploads', 'Uploads in progress', s.uploadsInProgress, `${s.graceVersions} finished in grace`)}
        {tile('jobs', 'Jobs retried', s.jobs.retried, `${s.jobs.fencedOut} stale ${s.jobs.fencedOut === 1 ? "write" : "writes"} fenced out · ${s.jobs.dead} gave up`, s.jobs.fencedOut ? 'good' : '')}
        {tile('emails', 'Receipts emailed', s.receiptsEmailed, 'queued in the outbox with the receipt')}
        <div className={`tile ${recon && typeof recon === 'object' && 'ok' in recon ? (recon.ok ? 'good' : 'bad') : ''}`} aria-live="polite">
          <span className="tile-label">Nothing lost?</span>
          {recon === null && <span className="tile-note">Check every stored file against the database.</span>}
          {recon === 'running' && <span className="tile-note">Checking the bucket…</span>}
          {recon && typeof recon === 'object' && 'error' in recon && <span className="tile-note">{recon.error}</span>}
          {recon && typeof recon === 'object' && 'ok' in recon && (
            <>
              <span className="tile-value">
                {recon.ok ? '✓' : '✗'} {recon.objectsFound}/{recon.distinctObjects}
              </span>
              <span className="tile-note">
                files found in the bucket · {recon.missing.length} missing · {recon.sizeMismatch.length} size mismatches ·{' '}
                {recon.completedUploadsWithoutVersion} uploads without a version · {recon.versionsWithoutJob} versions without a check
              </span>
            </>
          )}
          <button type="button" className="chip" onClick={verify} disabled={recon === 'running'}>
            {recon && recon !== 'running' ? 'Run again' : 'Verify now'}
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="pm-h">
        <h2 id="pm-h">Versions per minute, last 30 minutes before the deadline</h2>
        {s.perMinute.length === 0 ? (
          <p className="muted">No submissions in that window yet.</p>
        ) : (
          <ol className="bars">
            {s.perMinute.map((m) => (
              <li key={m.minute} className={new Date(m.minute).getTime() >= deadline ? 'after' : ''}>
                <span className="bar-v" style={{ height: `${(m.n / maxPerMin) * 100}%` }} />
                <span className="sr-only">
                  {new Date(m.minute).toLocaleTimeString()}: {m.n} versions
                </span>
                <span className="bar-n" aria-hidden="true">
                  {m.n}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="row">
        <button className="btn" onClick={exportCsv}>
          Export CSV
        </button>
        <span className="muted small">One row per team with the version that counts, its checks and SHA-256.</span>
      </div>

      {s.hackathon.isDemo && (
      <section className="card chaos" aria-labelledby="chaos-h">
        <h2 id="chaos-h">Fault injection (demo)</h2>
        <p className="small muted">
          The next check job freezes mid-check with no heartbeat, so its 30 s lease runs out. A second attempt takes over and
          finishes; when the frozen one wakes and tries to write, the lease fence refuses it. Watch Jobs retried and the
          fenced-out count, then check that the team still has exactly one result.
        </p>
        <div className="row">
          <button className="btn danger" onClick={armChaos} disabled={s.chaosArmed}>
            💥 Simulate worker crash mid-check
          </button>
          <span className="small" role="status">
            {s.chaosArmed ? 'Armed: waiting for the next upload…' : chaosNote}
          </span>
        </div>
      </section>
      )}

      <details className="card">
        <summary>Move the deadline (demo)</summary>
        <p className="small muted">For trying the policy: everything follows the server clock.</p>
        <div className="row">
          <button className="btn ghost" onClick={() => moveDeadline(1)}>In 1 minute</button>
          <button className="btn ghost" onClick={() => moveDeadline(5)}>In 5 minutes</button>
          <button className="btn ghost" onClick={() => moveDeadline(30)}>In 30 minutes</button>
          <button className="btn ghost" onClick={() => moveDeadline(0)}>Now</button>
        </div>
      </details>
    </div>
  );
}
