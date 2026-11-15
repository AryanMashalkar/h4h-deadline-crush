import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { del, get, post, type ApiError, type Submission, type Version } from '../api';
import { bytes, CHECK_LABEL, clock, STATUS_LABEL, when, whenMs } from '../format';
import { useLive, useServerClock } from '../live';
import { prehash, Upload, type PartState, type Progress } from '../upload';
import { disguisedPdf, samplePdf, zipBomb } from '../testkit';

export function TeamPage() {
  const { id } = useParams<{ id: string }>();
  const [sub, setSub] = useState<Submission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();

  const load = useCallback(() => {
    get<Submission>(`/api/teams/${id}/submission`)
      .then((s) => {
        setSub(s);
        setError(null);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  // Live: refetch (coalesced) on any event for this team, and after reconnecting.
  const connected = useLive(
    `/api/teams/${id}/events`,
    () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 150);
    },
    load,
  );
  const now = useServerClock(sub?.serverTime);

  if (error && !sub) return <p className="pad error" role="alert">{error}</p>;
  if (!sub) return <p className="pad muted" role="status">Loading…</p>;

  const deadline = new Date(sub.deadline).getTime();
  const graceEnd = deadline + sub.graceSeconds * 1000;
  const latest = sub.versions[0];

  return (
    <div className="wrap team">
      <div className="team-head">
        <div>
          <p className="eyebrow">Team</p>
          <h1 tabIndex={-1}>{sub.team.name}</h1>
        </div>
        <span className={`live ${connected ? 'on' : ''}`} role="status">
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      <DeadlineClock now={now} deadline={deadline} graceEnd={graceEnd} graceSeconds={sub.graceSeconds} />

      <div className="grid">
        <section aria-labelledby="submit-h" className="card">
          <h2 id="submit-h">{latest ? 'Submit a new version' : 'Submit your project'}</h2>
          <SubmitForm sub={sub} now={now} deadline={deadline} onDone={load} />
        </section>

        <section aria-labelledby="status-h" className="card">
          <h2 id="status-h">Status</h2>
          {latest ? <StatusPipeline version={latest} counted={latest.id === sub.countedVersionId} /> : <p className="muted">Nothing submitted yet.</p>}
          {sub.uploads.length > 0 && (
            <div className="notice">
              <strong>{sub.uploads.length === 1 ? 'An upload is unfinished.' : `${sub.uploads.length} uploads are unfinished.`}</strong>{' '}
              {sub.uploads.map((u) => (
                <span key={u.id} className="block small">
                  {u.fileName} ({bytes(u.size)}), started {whenMs(u.startedAt)}. Choose the same file again to resume where it stopped; it can
                  finish until {when(u.finishBy)}.{' '}
                  <button className="link" onClick={() => del(`/api/teams/${sub.team.id}/uploads/${u.id}`).then(load)}>
                    Cancel it
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="hist-h">
        <h2 id="hist-h">Versions</h2>
        <p className="muted small">Every version is kept. The newest one saved before the deadline is the one that counts.</p>
        {sub.versions.length === 0 ? (
          <p className="muted">No versions yet.</p>
        ) : (
          <ol className="versions" reversed>
            {sub.versions.map((v) => (
              <VersionCard key={v.id} v={v} counted={v.id === sub.countedVersionId} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function DeadlineClock({ now, deadline, graceEnd, graceSeconds }: { now: number; deadline: number; graceEnd: number; graceSeconds: number }) {
  const left = deadline - now;
  const state = left > 0 ? (left < 10 * 60_000 ? 'soon' : 'open') : now < graceEnd ? 'grace' : 'closed';
  return (
    <div className={`clock clock-${state}`} role="timer" aria-live="off">
      <div>
        <p className="eyebrow">
          {state === 'open' || state === 'soon' ? 'Deadline in' : state === 'grace' ? 'Deadline passed · grace for started uploads' : 'Submissions closed'}
        </p>
        <p className="clock-time">{state === 'open' || state === 'soon' ? clock(left) : state === 'grace' ? clock(graceEnd - now) : clock(0)}</p>
      </div>
      <dl className="clock-facts">
        <div>
          <dt>Deadline (server time)</dt>
          <dd>{when(new Date(deadline).toISOString())}</dd>
        </div>
        <div>
          <dt>Grace for uploads already started</dt>
          <dd>{Math.round(graceSeconds / 60)} min</dd>
        </div>
      </dl>
      <span className="sr-only" aria-live="polite">
        {state === 'grace' ? 'The deadline has passed.' : state === 'closed' ? 'Submissions are closed.' : ''}
      </span>
    </div>
  );
}

function SubmitForm({ sub, now, deadline, onDone }: { sub: Submission; now: number; deadline: number; onDone: () => void }) {
  const latest = sub.versions[0];
  const [title, setTitle] = useState(latest?.title ?? '');
  const [description, setDescription] = useState(latest?.description ?? '');
  const [links, setLinks] = useState((latest?.links ?? []).join('\n'));
  const [file, setFile] = useState<File | null>(null);
  const [hashed, setHashed] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const upload = useRef<Upload | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closed = now >= deadline;

  const linkList = links
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);

  function pick(f: File | null | undefined) {
    if (!f) return;
    if (f.size > sub.maxFileBytes) {
      setMessage({ kind: 'error', text: `That file is ${bytes(f.size)}; the limit is ${bytes(sub.maxFileBytes)}.` });
      return;
    }
    setMessage(null);
    setFile(f);
    setHashed(0);
    prehash(f, setHashed).catch(() => setHashed(-1));
  }

  async function loadSample(make: () => Promise<File>, sampleTitle: string) {
    try {
      const f = await make();
      if (!title.trim()) setTitle(sampleTitle);
      if (!links.trim()) setLinks('https://github.com/AryanMashalkar/h4h-deadline-crush');
      pick(f);
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    }
  }

  async function runUpload(u: Upload) {
    upload.current = u;
    setBusy(true);
    const v = await u.run();
    setBusy(false);
    if (v) {
      setMessage({ kind: 'ok', text: `Version ${v.versionNo} saved. Checks are running.` });
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onDone();
    } else if (u.p.phase === 'failed') setMessage({ kind: 'error', text: u.p.error ?? 'Upload failed' });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const details = { title: title.trim(), description: description.trim(), links: linkList };
    if (file) {
      await runUpload(new Upload(sub.team.id, file, details, setProgress));
      return;
    }
    setBusy(true);
    try {
      const v = await post<Version>(`/api/teams/${sub.team.id}/versions`, { ...details, clientKey: crypto.randomUUID() });
      setMessage({ kind: 'ok', text: `Version ${v.versionNo} saved${v.file ? ' with your latest file' : ''}.` });
      onDone();
    } catch (err) {
      setMessage({ kind: 'error', text: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  const active = progress && !['done', 'failed'].includes(progress.phase);

  return (
    <form onSubmit={submit} className="stack" aria-describedby={closed ? 'closed-note' : undefined}>
      <label>
        Project title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} disabled={busy} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} disabled={busy} />
      </label>
      <label>
        Links <span className="muted small">(one per line: repo, demo, video)</span>
        <textarea value={links} onChange={(e) => setLinks(e.target.value)} rows={2} disabled={busy} inputMode="url" spellCheck={false} />
      </label>

      <div
        className={`drop ${drag ? 'drag' : ''}`}
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <label className="drop-label">
          <span>{file ? <strong>{file.name}</strong> : 'Project file'}</span>
          <span className="muted small">
            {file
              ? `${bytes(file.size)} · ${hashed < 0 ? 'fingerprint failed, it will retry on upload' : hashed < 1 ? `fingerprinting ${Math.round(hashed * 100)}%` : 'fingerprint ready (SHA-256)'}`
              : `PDF, ZIP, PNG, JPEG, MP4 or WebM, up to ${bytes(sub.maxFileBytes)}. Drop it here or choose.`}
          </span>
          <input ref={fileInput} className="sr-only" type="file" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
          <span className="pick-btn" aria-hidden="true">
            ↑ {file ? 'Choose another file' : 'Choose a file'}
          </span>
        </label>
        {!file && latest?.file && <p className="muted small">Leave empty to keep {latest.file.name}.</p>}
      </div>

      <div className="testkit" role="group" aria-label="Judge test kit">
        <span className="muted small">Judge test kit, one click:</span>
        <button type="button" className="chip" disabled={busy} onClick={() => loadSample(async () => samplePdf(), 'Sample project')}>
          Valid 45 MB PDF (5 parts)
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => loadSample(zipBomb, 'Zip bomb test')}>
          1029:1 zip bomb
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => loadSample(async () => disguisedPdf(), 'Disguised file test')}>
          Program renamed to .pdf
        </button>
      </div>

      {progress && <UploadProgress p={progress} onPause={() => upload.current?.pause()} onResume={() => upload.current && runUpload(upload.current)} />}

      <div className="row">
        <button className="btn" disabled={busy || closed || !title.trim()}>
          {busy ? (active ? 'Uploading…' : 'Saving…') : file ? 'Upload and submit' : 'Save details'}
        </button>
        {closed && (
          <span id="closed-note" className="muted small">
            The deadline has passed. You can still try; the server will refuse and the attempt is logged.
          </span>
        )}
      </div>
      {closed && (
        <button
          type="button"
          className="link small"
          onClick={async () => {
            try {
              await post(`/api/teams/${sub.team.id}/versions`, { title: title || 'late', description, links: linkList, clientKey: crypto.randomUUID() });
            } catch (err) {
              setMessage({ kind: 'error', text: `${(err as ApiError).message}. Refused by the server.` });
            }
          }}
        >
          Try a late edit anyway
        </button>
      )}
      <div aria-live="polite">{message && <p className={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</p>}</div>
    </form>
  );
}

const partLabel: Record<PartState, string> = { todo: 'waiting', sending: 'sending', done: 'stored', kept: 'stored before the drop, not sent again' };

function PartGrid({ parts }: { parts: PartState[] }) {
  return (
    <ol className="parts" aria-label="10 MiB parts">
      {parts.map((st, i) => (
        <li key={i} className={`part part-${st}`} title={`Part ${i + 1}: ${partLabel[st]}`}>
          <span className="mono">{i + 1}</span>
          {st === 'done' || st === 'kept' ? ' ✓' : ''}
        </li>
      ))}
    </ol>
  );
}

function UploadProgress({ p, onPause, onResume }: { p: Progress; onPause: () => void; onResume: () => void }) {
  const pct = p.phase === 'hashing' ? p.hashed : p.total ? p.sent / p.total : 0;
  const label =
    p.phase === 'hashing'
      ? 'Fingerprinting the file (SHA-256)'
      : p.phase === 'starting'
        ? 'Starting upload'
        : p.phase === 'uploading'
          ? `Uploading ${p.partCount} parts straight to storage${p.resumed ? ' (resumed: stored parts are skipped)' : ''}`
          : p.phase === 'offline'
            ? 'Offline: will continue when you reconnect'
            : p.phase === 'paused'
              ? 'Connection dropped'
              : p.phase === 'finishing'
                ? 'Finishing'
                : p.phase === 'done'
                  ? 'Uploaded'
                  : `Failed: ${p.error}`;
  return (
    <div className={`progress progress-${p.phase}`}>
      <div className="progress-top">
        <span>{label}</span>
        <span className="mono">{Math.round(pct * 100)}%</span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${pct * 100}%` }} />
      </div>
      {p.parts && p.parts.length > 0 && <PartGrid parts={p.parts} />}
      <div className="progress-top small muted">
        <span>
          {bytes(p.sent)} of {bytes(p.total)}
          {p.phase === 'paused' && p.parts ? ` · ${p.parts.filter((x) => x === 'done' || x === 'kept').length} of ${p.parts.length} parts already safe in storage` : ''}
        </span>
        {(p.phase === 'uploading' || p.phase === 'offline') && (
          <button type="button" className="chip" onClick={onPause}>
            ⚡ Simulate network drop
          </button>
        )}
        {(p.phase === 'paused' || p.phase === 'failed') && (
          <button type="button" className="chip strong" onClick={onResume}>
            ▶ Resume{p.parts && p.parts.some((x) => x === 'done' || x === 'kept') ? ` from part ${p.parts.findIndex((x) => x !== 'done' && x !== 'kept') + 1}` : ''}
          </button>
        )}
      </div>
    </div>
  );
}

const STEPS = ['uploading', 'checking', 'result'] as const;

function StatusPipeline({ version, counted }: { version: Version; counted: boolean }) {
  const done = version.status !== 'checking';
  const result = version.status;
  return (
    <div>
      <ol className="pipeline" aria-label="Submission status">
        {STEPS.map((s, i) => {
          const state = i === 0 ? 'done' : i === 1 ? (done ? 'done' : 'current') : done ? result : 'todo';
          const text = s === 'result' ? (done ? STATUS_LABEL[result] : 'Accepted or needs a fix') : STATUS_LABEL[s];
          return (
            <li key={s} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="step-dot" aria-hidden="true" />
              {text}
            </li>
          );
        })}
      </ol>
      <p className="small">
        Version {version.versionNo} · {version.file ? version.file.name : 'no file'} {counted && <span className="tag tag-count">counts</span>}
      </p>
      {version.statusReason && <p className={result === 'accepted' ? 'ok' : 'error'}>{version.statusReason}</p>}
    </div>
  );
}

function VersionCard({ v, counted }: { v: Version; counted: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  async function open(what: 'download' | 'preview') {
    const r = await get<{ url: string }>(`/api/versions/${v.id}/${what}`);
    if (what === 'download') window.location.href = r.url;
    else setPreview(r.url);
  }
  return (
    <li className={`version ${counted ? 'counted' : ''}`}>
      <div className="version-head">
        <h3>
          v{v.versionNo} · {v.title}
        </h3>
        <span className={`tag tag-${v.status}`}>{STATUS_LABEL[v.status]}</span>
        {counted && <span className="tag tag-count">counts</span>}
        {v.inGrace && <span className="tag tag-grace">finished in grace</span>}
      </div>
      <p className="small muted">
        Submitted <span className="mono">{whenMs(v.effectiveAt)}</span>
        {v.inGrace && (
          <>
            {' '}
            (upload started then, finished <span className="mono">{whenMs(v.createdAt)}</span>)
          </>
        )}{' '}
        by {v.createdBy}
      </p>
      {v.file && (
        <p className="small">
          {v.file.name} · {bytes(v.file.size)}
          {v.detectedType && <> · detected {v.detectedType}</>} ·{' '}
          <button className="link" onClick={() => open('download')}>
            Download
          </button>
          {v.hasPreview && (
            <>
              {' · '}
              <button className="link" onClick={() => open('preview')}>
                Preview page 1
              </button>
            </>
          )}
        </p>
      )}
      {v.sha256 && v.status === 'accepted' && (
        <p className="small receipt">
          Receipt · SHA-256 <span className="mono hash">{v.sha256}</span>
        </p>
      )}
      {v.checks.length > 0 && (
        <ul className="checks">
          {v.checks.map((c) => (
            <li key={c.name} className={c.ok ? 'pass' : 'fail'}>
              <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span> <span className="sr-only">{c.ok ? 'Passed:' : 'Failed:'}</span>
              {CHECK_LABEL[c.name] ?? c.name}
              {c.name === 'file_type' && <span className="muted"> · {String(c.detail.detected)}</span>}
              {c.name === 'archive' && !c.ok && <span className="muted"> · {String(c.detail.error)}</span>}
              {c.name === 'links' && (
                <ul className="small">
                  {(c.detail.links as { url: string; ok: boolean; status?: number; error?: string }[]).map((l) => (
                    <li key={l.url} className={l.ok ? 'pass' : 'fail'}>
                      {l.url} <span className="muted">· {l.ok ? l.status : l.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview && <img className="preview" src={preview} alt={`First page of ${v.file?.name}`} />}
      {v.previewText && (
        <details>
          <summary className="small">README from the archive</summary>
          <pre className="readme">{v.previewText}</pre>
        </details>
      )}
    </li>
  );
}
