import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '../src/services/organizer.js';
import { reconcile } from '../src/reconcile.js';
import { Worker } from '../src/worker/worker.js';
import { api, details, fixture, setDeadline, startHarness, tinyPdf, uploadFile, waitForJobs, type Harness } from './helpers.js';

let h: Harness;
let worker: Worker;
beforeAll(async () => {
  h = await startHarness();
  worker = new Worker({ pool: h.pool, storage: h.storage, concurrency: 2, pollMs: 50 });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  await h.close();
});

/** Reads an SSE stream until `count` events arrived. */
async function collectEvents(url: string, count: number, during: () => Promise<unknown>) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const reading = (async () => {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  await during();
  await Promise.race([reading, new Promise((r) => setTimeout(r, 10_000))]);
  ac.abort();
  return events;
}

describe('live status', () => {
  it('a team sees its submission move from uploading to checking to accepted without refreshing', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const events = await collectEvents(`${h.baseUrl}/api/teams/${f.teamId}/events?access_token=${f.token}`, 4, () => uploadFile(call, f.teamId, tinyPdf()));
    expect(events.map((e) => e.event)).toEqual(['upload.started', 'version.created', 'upload.completed', 'version.checked']);
    expect(events[3]!.data.status).toBe('accepted');
  });
});

describe('organizer dashboard', () => {
  it('counts submissions, late attempts and failed checks, and exports CSV', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    await uploadFile(call, f.teamId, tinyPdf());
    await uploadFile(api(h.baseUrl, f.otherToken), f.otherTeamId, Buffer.from('not a real file'), { fileName: '=HYPERLINK("evil").pdf' });
    await waitForJobs(h.pool);
    await setDeadline(h.pool, f.hackathonId, -1);
    await call('POST', `/api/teams/${f.teamId}/versions`, { ...details(), clientKey: randomUUID() });

    const org = api(h.baseUrl, f.organizerToken);
    const stats = await org('GET', `/api/hackathons/${f.hackathonId}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      teams: 2,
      teamsSubmitted: 2,
      counted: { accepted: 1, needsFix: 1, checking: 0 },
      lateAttempts: 1,
      versionsFailedChecks: 1,
      failedByCheck: { file_type: 1 },
    });

    const csv = await fetch(`${h.baseUrl}/api/hackathons/${f.hackathonId}/export.csv`, { headers: { authorization: `Bearer ${f.organizerToken}` } });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(text).toContain(`"'=HYPERLINK(""evil"").pdf"`); // formula neutralised
  });

  it('csvCell neutralises formulas and quotes everything', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('a "b"')).toBe(`"a ""b"""`);
    expect(csvCell(null)).toBe('""');
  });
});

describe('nothing lost', () => {
  it('reconciliation matches every version to a stored object and flags a missing one', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    for (let i = 0; i < 5; i++) await uploadFile(call, f.teamId, tinyPdf());
    await waitForJobs(h.pool);
    const good = await reconcile(h.pool, h.storage, f.hackathonId);
    expect(good).toMatchObject({ ok: true, versionsWithFile: 5, objectsFound: 5, missing: [], unfinishedJobs: 0 });

    const victim = await h.pool.query('SELECT id, object_key FROM versions WHERE team_id = $1 ORDER BY version_no LIMIT 1', [f.teamId]);
    await h.storage.delete(victim.rows[0].object_key);
    const bad = await reconcile(h.pool, h.storage, f.hackathonId);
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual([{ versionId: victim.rows[0].id, key: victim.rows[0].object_key }]);
  });
});
