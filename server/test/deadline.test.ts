import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireUploads } from '../src/worker/worker.js';
import { api, details, fixture, setDeadline, sha256, startHarness, tinyPdf, uploadFile, uploadParts, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

/** Evaluates the policy function with exact timestamps (microsecond precision). */
async function win(action: 'start' | 'transfer', startedOffsetUs: number | null, nowOffsetUs: number, graceSeconds = 900) {
  const { rows } = await h.pool.query(
    `SELECT submission_window(d, $1, $2, CASE WHEN $3::bigint IS NULL THEN NULL ELSE d + make_interval(secs => $3::bigint / 1e6) END,
                              d + make_interval(secs => $4::bigint / 1e6)) AS w
       FROM (SELECT '2026-11-15T18:29:00Z'::timestamptz AS d) x`,
    [graceSeconds, action, startedOffsetUs, nowOffsetUs],
  );
  return rows[0].w;
}

describe('deadline policy (submission_window), at the boundary', () => {
  it('start: 1 µs before the deadline is open, exactly at the deadline is closed', async () => {
    expect(await win('start', null, -1)).toBe('open');
    expect(await win('start', null, 0)).toBe('closed');
    expect(await win('start', null, 1)).toBe('closed');
  });

  it('transfer: an upload started 1 µs before the deadline gets grace, until exactly deadline + grace', async () => {
    expect(await win('transfer', -1, 1)).toBe('grace');
    expect(await win('transfer', -1, 900e6 - 1)).toBe('grace');
    expect(await win('transfer', -1, 900e6)).toBe('closed');
  });

  it('transfer: an upload started exactly at the deadline gets no grace', async () => {
    expect(await win('transfer', 0, 1)).toBe('closed');
  });

  it('grace of 0 means the deadline is hard for everyone', async () => {
    expect(await win('transfer', -1000, 1, 0)).toBe('closed');
  });
});

describe('deadline enforcement over HTTP (server clock only)', () => {
  it('refuses to start an upload after the deadline and logs a late attempt', async () => {
    const f = await fixture(h.pool, -1);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    // A client claiming an earlier time changes nothing: unknown fields are ignored, the DB clock decides.
    const res = await call('POST', `/api/teams/${f.teamId}/uploads`, {
      ...details(), clientKey: randomUUID(), fileName: 'a.pdf', size: file.length, sha256: sha256(file), clientTime: '2020-01-01T00:00:00Z',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEADLINE_PASSED');
    const late = await h.pool.query('SELECT action FROM late_attempts WHERE team_id = $1', [f.teamId]);
    expect(late.rows.map((r) => r.action)).toEqual(['start_upload']);
  });

  it('refuses edits after the deadline', async () => {
    const f = await fixture(h.pool, 200);
    const call = api(h.baseUrl, f.token);
    expect((await call('POST', `/api/teams/${f.teamId}/versions`, { ...details(), clientKey: randomUUID() })).status).toBe(201);
    await setDeadline(h.pool, f.hackathonId, -1);
    const late = await call('POST', `/api/teams/${f.teamId}/versions`, { ...details({ title: 'changed' }), clientKey: randomUUID() });
    expect(late.status).toBe(403);
  });

  it('an upload started before the deadline can finish in the grace period and counts', async () => {
    const f = await fixture(h.pool, 60_000);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const up = await uploadParts(call, f.teamId, file);
    // Move the deadline to 1 ms after this upload started: we are now in grace.
    await h.pool.query(
      `UPDATE hackathons SET deadline = (SELECT started_at FROM upload_sessions WHERE id = $2) + interval '1 millisecond' WHERE id = $1`,
      [f.hackathonId, up.start.body.id],
    );
    await new Promise((r) => setTimeout(r, 5));
    const complete = await call('POST', `/api/teams/${f.teamId}/uploads/${up.start.body.id}/complete`, { parts: up.parts });
    expect(complete.status).toBe(201);
    expect(complete.body.inGrace).toBe(true);
    expect(new Date(complete.body.effectiveAt).getTime()).toBeLessThan(new Date(complete.body.createdAt).getTime());
    const sub = await call('GET', `/api/teams/${f.teamId}/submission`);
    expect(sub.body.countedVersionId).toBe(complete.body.id);
  });

  it('in grace, part URLs never outlive deadline + grace', async () => {
    const f = await fixture(h.pool, 60_000, 30);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const start = await call('POST', `/api/teams/${f.teamId}/uploads`, { ...details(), clientKey: randomUUID(), fileName: 'a.pdf', size: file.length, sha256: sha256(file) });
    await h.pool.query(`UPDATE hackathons SET deadline = clock_timestamp() - interval '10 seconds' WHERE id = $1`, [f.hackathonId]);
    await h.pool.query(`UPDATE upload_sessions SET started_at = clock_timestamp() - interval '20 seconds' WHERE id = $1`, [start.body.id]);
    const signed = await call('POST', `/api/teams/${f.teamId}/uploads/${start.body.id}/parts`, { partNumbers: [1] });
    expect(signed.status).toBe(200);
    expect(signed.body.window).toBe('grace');
    expect(signed.body.expiresIn).toBeLessThanOrEqual(20);
    expect(new URL(signed.body.urls[0].url).searchParams.get('X-Amz-Expires')).toBe(String(signed.body.expiresIn));
  });

  it('after deadline + grace an unfinished upload is refused, logged, and expired', async () => {
    const f = await fixture(h.pool, 60_000, 0);
    const call = api(h.baseUrl, f.token);
    const up = await uploadParts(call, f.teamId, tinyPdf());
    await setDeadline(h.pool, f.hackathonId, -1);
    const res = await call('POST', `/api/teams/${f.teamId}/uploads/${up.start.body.id}/complete`, { parts: up.parts });
    expect(res.status).toBe(403);
    expect((await call('POST', `/api/teams/${f.teamId}/uploads/${up.start.body.id}/parts`, { partNumbers: [1] })).status).toBe(403);
    await expireUploads(h.pool, h.storage);
    const s = await h.pool.query('SELECT status FROM upload_sessions WHERE id = $1', [up.start.body.id]);
    expect(s.rows[0].status).toBe('expired');
    const late = await h.pool.query('SELECT count(*)::int AS n FROM late_attempts WHERE team_id = $1', [f.teamId]);
    expect(late.rows[0].n).toBe(2);
  });

  it('the last version before the deadline counts, and every version is kept', async () => {
    const f = await fixture(h.pool, 60_000);
    const call = api(h.baseUrl, f.token);
    const v1 = await uploadFile(call, f.teamId, tinyPdf());
    const v2 = await call('POST', `/api/teams/${f.teamId}/versions`, { ...details({ title: 'Better title' }), clientKey: randomUUID() });
    expect(v2.body.versionNo).toBe(2);
    expect(v2.body.file.declaredSha256).toBe(v1.complete.body.file.declaredSha256); // edit keeps the file
    await setDeadline(h.pool, f.hackathonId, -1);
    await call('POST', `/api/teams/${f.teamId}/versions`, { ...details({ title: 'Too late' }), clientKey: randomUUID() });
    const sub = await call('GET', `/api/teams/${f.teamId}/submission`);
    expect(sub.body.versions.map((v: any) => v.versionNo)).toEqual([2, 1]);
    expect(sub.body.countedVersionId).toBe(v2.body.id);
  });

  it('20 members saving at the same instant get distinct, gap-free version numbers', async () => {
    const f = await fixture(h.pool, 60_000);
    const call = api(h.baseUrl, f.token);
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', `/api/teams/${f.teamId}/versions`, { ...details({ title: `t${i}` }), clientKey: randomUUID() })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(res.map((r) => r.body.versionNo).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
