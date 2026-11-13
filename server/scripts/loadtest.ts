/**
 * Load test: 2,000 teams submit in the 10 minutes before the deadline.
 *
 *   cd server && npm run seed -- --teams 2000 --deadline-minutes 10 --tokens ../loadtest/tokens.json
 *   npm run loadtest -- --base http://localhost:3000 --tokens ../loadtest/tokens.json
 *
 * Open model (like k6's ramping-arrival-rate): each team starts at a scheduled
 * time no matter how slow the server is, so a slow server cannot hide by
 * slowing the test down. Arrivals are back-loaded: cumulative share by time t
 * is (t/T)^3, so ~27% of teams arrive in the last minute (peak ~10 teams/s).
 * About 10% of teams also save a second version, and ~2% try after the
 * deadline (those must be refused).
 *
 * Each team: GET status -> start upload -> sign parts -> PUT parts straight to
 * storage -> complete -> GET status. Only API calls count toward API latency;
 * storage PUTs are reported separately. Afterwards every accepted submission is
 * reconciled against the database and the bucket: nothing may be lost.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ connections: 512, pipelining: 1, keepAliveTimeout: 30_000 }));

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const base = arg('base', 'http://localhost:3000');
const fileKb = Number(arg('file-kb', '64'));
const lateShare = Number(arg('late-share', '0.02'));
const resubmitShare = Number(arg('resubmit-share', '0.1'));
const out = arg('out', '');
const { hackathonId, deadline, teams, organizerToken } = JSON.parse(await readFile(arg('tokens', '../loadtest/tokens.json'), 'utf8')) as {
  hackathonId: string;
  deadline: string;
  organizerToken: string;
  teams: { teamId: string; token: string }[];
};

const deadlineMs = new Date(deadline).getTime();
const startMs = Date.now();
const windowMs = deadlineMs - startMs;
if (windowMs < 30_000) throw new Error('deadline is too close; seed again');

const lat: Record<string, number[]> = {};
const errors: Record<string, number> = {};
const record = (k: string, ms: number) => (lat[k] ??= []).push(ms);
const fail = (k: string) => (errors[k] = (errors[k] ?? 0) + 1);

async function call(token: string, name: string, method: string, path: string, body?: unknown) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    record(name, performance.now() - t0);
    return { status: res.status, body: json as any };
  } catch (e) {
    record(name, performance.now() - t0);
    fail(`${name}:network`);
    return { status: 0, body: null };
  }
}

const tinyPdfHeader = Buffer.from('%PDF-1.4\n%load-test\n');
const completed: { teamId: string; versionId: string; sha: string }[] = [];
let refusedLate = 0;
let acceptedLate = 0;
let inflight = 0;
let maxInflight = 0;

async function submit(t: { teamId: string; token: string }, late: boolean) {
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
  try {
    await call(t.token, 'GET submission', 'GET', `/api/teams/${t.teamId}/submission`);
    const file = Buffer.concat([tinyPdfHeader, randomBytes(fileKb * 1024)]);
    const sha = createHash('sha256').update(file).digest('hex');
    const start = await call(t.token, 'POST start upload', 'POST', `/api/teams/${t.teamId}/uploads`, {
      title: `Project of ${t.teamId.slice(0, 8)}`,
      description: 'load test',
      links: [],
      clientKey: randomUUID(),
      fileName: 'project.pdf',
      contentType: 'application/pdf',
      size: file.length,
      sha256: sha,
    });
    if (late) {
      if (start.status === 403) refusedLate++;
      else if (start.status < 300) acceptedLate++;
      else fail(`late:${start.status}`);
      return;
    }
    if (start.status !== 201) return fail(`start:${start.status}`);
    const s = start.body;
    const signed = await call(t.token, 'POST sign parts', 'POST', `/api/teams/${t.teamId}/uploads/${s.id}/parts`, {
      partNumbers: Array.from({ length: s.partCount }, (_, i) => i + 1),
    });
    if (signed.status !== 200) return fail(`sign:${signed.status}`);
    const parts = [];
    for (const u of signed.body.urls) {
      const chunk = file.subarray((u.partNumber - 1) * s.partSize, u.partNumber * s.partSize);
      const t0 = performance.now();
      const put = await fetch(u.url, { method: 'PUT', body: new Uint8Array(chunk) }).catch(() => null);
      record('storage PUT part (not API)', performance.now() - t0);
      if (!put?.ok) return fail(`put:${put?.status ?? 'network'}`);
      parts.push({ partNumber: u.partNumber, etag: put.headers.get('etag') });
    }
    const done = await call(t.token, 'POST complete', 'POST', `/api/teams/${t.teamId}/uploads/${s.id}/complete`, { parts });
    if (done.status !== 201) return fail(`complete:${done.status}`);
    completed.push({ teamId: t.teamId, versionId: done.body.id, sha });
    await call(t.token, 'GET submission', 'GET', `/api/teams/${t.teamId}/submission`);
  } finally {
    inflight--;
  }
}

async function resubmit(t: { teamId: string; token: string }) {
  const r = await call(t.token, 'POST save details', 'POST', `/api/teams/${t.teamId}/versions`, {
    title: 'Updated title',
    description: 'second version',
    links: [],
    clientKey: randomUUID(),
  });
  if (r.status !== 201) fail(`resubmit:${r.status}`);
}

// Schedule: on-time teams by (t/T)^3 inside the window, late teams 1-20 s after the deadline.
const nLate = Math.round(teams.length * lateShare);
const onTime = teams.slice(0, teams.length - nLate);
const lateTeams = teams.slice(teams.length - nLate);
const usable = windowMs - 15_000; // leave the last 15 s for stragglers to finish
const tasks: Promise<unknown>[] = [];
onTime.forEach((t, i) => {
  const at = startMs + usable * Math.cbrt((i + 0.5) / onTime.length);
  tasks.push(
    new Promise((r) => setTimeout(r, Math.max(0, at - Date.now()))).then(async () => {
      await submit(t, false);
      if (Math.random() < resubmitShare && Date.now() < deadlineMs - 2000) await resubmit(t);
    }),
  );
});
lateTeams.forEach((t) => {
  const at = deadlineMs + 1000 + Math.random() * 19_000;
  tasks.push(new Promise((r) => setTimeout(r, at - Date.now())).then(() => submit(t, true)));
});

const ticker = setInterval(() => {
  const n = Object.values(lat).reduce((s, l) => s + l.length, 0);
  console.log(`${Math.round((Date.now() - startMs) / 1000)}s  completed=${completed.length}/${onTime.length}  inflight=${inflight}  requests=${n}`);
}, 10_000);
await Promise.all(tasks);
clearInterval(ticker);

// Let the workers drain, then reconcile through the organizer view and the bucket.
console.log('all teams done; waiting for checks to finish…');
const org = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${organizerToken}` } });
let stats: any;
for (let i = 0; i < 600; i++) {
  stats = await (await org(`/api/hackathons/${hackathonId}/stats`)).json();
  if (stats.jobs.queued + stats.jobs.running === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const reconcile = await (await org(`/api/hackathons/${hackathonId}/reconcile`)).json();
// Per team: the counted file's SHA-256, computed by a worker from the bytes in
// the bucket, must equal the SHA-256 this client computed before uploading.
const csv = await (await org(`/api/hackathons/${hackathonId}/export.csv`)).text();
const rows = csv.trim().split('\r\n').slice(1).map((l) => l.slice(1, -1).split('","'));
const counted = new Map(rows.map((r) => [r[1], { sha: r[8], status: r[10] }]));
const lost = completed.filter((c) => counted.get(c.teamId)?.sha !== c.sha);
const nothingLost = {
  completedUploads: completed.length,
  teamsWithCountedVersion: rows.filter((r) => r[3] !== '').length,
  shaMatches: completed.length - lost.length,
  lost: lost.length,
  reconcile,
  finalStats: { teamsSubmitted: stats.teamsSubmitted, counted: stats.counted, lateAttempts: stats.lateAttempts, jobs: stats.jobs },
};
console.log('nothing-lost check:', JSON.stringify(nothingLost, null, 2));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : 0;
};
const apiAll = Object.entries(lat).filter(([k]) => !k.startsWith('storage')).flatMap(([, v]) => v);
const report = {
  hackathonId,
  teams: teams.length,
  windowSeconds: Math.round(windowMs / 1000),
  fileBytes: fileKb * 1024 + tinyPdfHeader.length,
  onTimeTeams: onTime.length,
  completed: completed.length,
  lateAttempts: nLate,
  lateRefused: refusedLate,
  lateAccepted: acceptedLate,
  maxInflight,
  errors,
  nothingLost,
  api: {
    requests: apiAll.length,
    p50: +pct(apiAll, 50).toFixed(1),
    p95: +pct(apiAll, 95).toFixed(1),
    p99: +pct(apiAll, 99).toFixed(1),
    max: +Math.max(...apiAll).toFixed(1),
  },
  endpoints: Object.fromEntries(
    Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1), p99: +pct(v, 99).toFixed(1) }]),
  ),
};
if (out) await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const ok = completed.length === onTime.length && acceptedLate === 0 && report.api.p95 < 300 && lost.length === 0 && reconcile.ok;
process.exit(ok ? 0 : 1);
