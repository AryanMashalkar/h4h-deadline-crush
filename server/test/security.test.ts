import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, details, fixture, sha256, startHarness, tinyPdf, uploadFile, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const startBody = (over: Record<string, unknown> = {}) => {
  const file = tinyPdf();
  return { ...details(), clientKey: randomUUID(), fileName: 'p.pdf', size: file.length, sha256: sha256(file), ...over };
};

describe('access control', () => {
  it('requires a valid token', async () => {
    const f = await fixture(h.pool);
    expect((await api(h.baseUrl)('GET', `/api/teams/${f.teamId}/submission`)).status).toBe(401);
    expect((await api(h.baseUrl, 'not-a-jwt')('GET', `/api/teams/${f.teamId}/submission`)).status).toBe(401);
  });

  it("members of another team cannot see, upload to, or download a team's files", async () => {
    const f = await fixture(h.pool);
    const { complete } = await uploadFile(api(h.baseUrl, f.token), f.teamId, tinyPdf());
    const intruder = api(h.baseUrl, f.otherToken);
    expect((await intruder('GET', `/api/teams/${f.teamId}/submission`)).status).toBe(404);
    expect((await intruder('POST', `/api/teams/${f.teamId}/uploads`, startBody())).status).toBe(404);
    expect((await intruder('POST', `/api/teams/${f.teamId}/versions`, { ...details(), clientKey: randomUUID() })).status).toBe(404);
    expect((await intruder('GET', `/api/versions/${complete.body.id}/download`)).status).toBe(404);
    expect((await intruder('GET', `/api/teams/${f.teamId}/events`)).status).toBe(404);
    // Using someone else's upload id under your own team does not work either.
    expect((await intruder('POST', `/api/teams/${f.otherTeamId}/uploads/${complete.body.id}/complete`, { parts: [{ partNumber: 1, etag: 'x' }] })).status).toBe(404);
  });

  it('organizers can read any team but cannot submit for one', async () => {
    const f = await fixture(h.pool);
    const org = api(h.baseUrl, f.organizerToken);
    expect((await org('GET', `/api/teams/${f.teamId}/submission`)).status).toBe(200);
    expect((await org('POST', `/api/teams/${f.teamId}/uploads`, startBody())).status).toBe(404);
  });

  it('participants cannot use organizer endpoints; a demo organizer sees only their own hackathon', async () => {
    const f = await fixture(h.pool);
    expect((await api(h.baseUrl, f.token)('GET', `/api/hackathons/${f.hackathonId}/stats`)).status).toBe(403);
    const demo = await api(h.baseUrl)('POST', '/api/demo', { minutes: 5 });
    expect(demo.status).toBe(200);
    const demoOrg = api(h.baseUrl, demo.body.organizerToken);
    expect((await demoOrg('GET', `/api/hackathons/${demo.body.hackathonId}/stats`)).status).toBe(200);
    expect((await demoOrg('GET', `/api/hackathons/${f.hackathonId}/stats`)).status).toBe(403);
    expect((await demoOrg('GET', `/api/teams/${f.teamId}/submission`)).status).toBe(404);
  });

  it('download links are signed and short-lived', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const { complete } = await uploadFile(call, f.teamId, tinyPdf());
    const link = await call('GET', `/api/versions/${complete.body.id}/download`);
    const url = new URL(link.body.url);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    expect((await fetch(link.body.url)).status).toBe(200);
    url.searchParams.set('X-Amz-Expires', '86400');
    expect((await fetch(url)).status).toBeGreaterThanOrEqual(400); // tampering breaks the signature
    expect((await fetch(url)).status).toBeLessThan(500);
  });
});

describe('headers', () => {
  it('sends a CSP that only allows the bucket as an extra origin, and no-store on API responses', async () => {
    const res = await fetch(`${h.baseUrl}/api/health`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/connect-src 'self' http:\/\/localhost:3900/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('input validation', () => {
  it('rejects bad uploads before anything is created', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const cases: [Record<string, unknown>, number][] = [
      [{ sha256: 'abc' }, 400],
      [{ size: 0 }, 400],
      [{ size: 100 * 1024 * 1024 + 1 }, 413],
      [{ fileName: '../../etc/passwd' }, 400],
      [{ links: ['javascript:alert(1)'] }, 400],
      [{ links: Array.from({ length: 11 }, () => 'https://example.com') }, 400],
      [{ title: '' }, 400],
      [{ clientKey: 'short' }, 400],
    ];
    for (const [over, status] of cases) {
      const res = await call('POST', `/api/teams/${f.teamId}/uploads`, startBody(over));
      expect(res.status, JSON.stringify(over)).toBe(status);
    }
    expect((await call('GET', '/api/teams/not-a-uuid/submission')).status).toBe(400);
    const n = await h.pool.query('SELECT count(*)::int AS n FROM upload_sessions WHERE team_id = $1', [f.teamId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('refuses to complete with a wrong part list and refuses a size that differs from the declaration', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const start = await call('POST', `/api/teams/${f.teamId}/uploads`, startBody({ size: file.length + 10 }));
    const signed = await call('POST', `/api/teams/${f.teamId}/uploads/${start.body.id}/parts`, { partNumbers: [1] });
    expect((await call('POST', `/api/teams/${f.teamId}/uploads/${start.body.id}/parts`, { partNumbers: [2] })).status).toBe(400);
    const put = await fetch(signed.body.urls[0].url, { method: 'PUT', body: new Uint8Array(file) });
    const parts = [{ partNumber: 1, etag: put.headers.get('etag')! }];
    expect((await call('POST', `/api/teams/${f.teamId}/uploads/${start.body.id}/complete`, { parts: [...parts, { partNumber: 2, etag: 'x' }] })).status).toBe(400);
    const res = await call('POST', `/api/teams/${f.teamId}/uploads/${start.body.id}/complete`, { parts });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SIZE_MISMATCH');
  });

  it('caps uploads in progress per team', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const res = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/api/teams/${f.teamId}/uploads`, startBody())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
  });
});
