import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/worker/worker.js';
import { api, details, fixture, sha256, startHarness, tinyPdf, uploadFile, uploadParts, waitForJobs, type Harness } from './helpers.js';

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

describe('upload flow', () => {
  it('uploads a multi-part file straight to storage, verifies it and issues a receipt', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    // 12 MiB + PDF header => 2 parts of 10 MiB max
    const pdf = Buffer.concat([tinyPdf(), randomBytes(12 * 1024 * 1024)]);
    const { start, complete } = await uploadFile(call, f.teamId, pdf);
    expect(start.status).toBe(201);
    expect(start.body.partCount).toBe(2);
    expect(complete.status).toBe(201);
    expect(complete.body.status).toBe('checking');
    await waitForJobs(h.pool);
    const sub = await call('GET', `/api/teams/${f.teamId}/submission`);
    const v = sub.body.versions[0];
    expect(v.status).toBe('accepted');
    expect(v.sha256).toBe(sha256(pdf));
    expect(v.detectedType).toBe('application/pdf');
    expect(sub.body.countedVersionId).toBe(v.id);
    const receipts = await h.pool.query('SELECT * FROM receipts WHERE version_id = $1', [v.id]);
    expect(receipts.rows[0].sha256).toBe(sha256(pdf));
  });

  it('completing twice returns the same version (idempotent)', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const up = await uploadParts(call, f.teamId, file);
    const path = `/api/teams/${f.teamId}/uploads/${up.start.body.id}/complete`;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => call('POST', path, { parts: up.parts })));
    const ids = new Set([a, b, c].map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect([a, b, c].map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const n = await h.pool.query('SELECT count(*)::int AS n FROM versions WHERE team_id = $1', [f.teamId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('starting the same upload twice (same clientKey) creates one session', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const body = { ...details(), clientKey: randomUUID(), fileName: 'a.pdf', size: file.length, sha256: sha256(file) };
    const res = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/api/teams/${f.teamId}/uploads`, body)));
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('rejects a file whose bytes differ from the declared SHA-256', async () => {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const file = tinyPdf();
    const { complete } = await uploadFile(call, f.teamId, file, { sha: sha256(Buffer.from('something else')) });
    expect(complete.status).toBe(201);
    await waitForJobs(h.pool);
    const sub = await call('GET', `/api/teams/${f.teamId}/submission`);
    expect(sub.body.versions[0].status).toBe('rejected');
    expect(sub.body.countedVersionId).toBeNull();
  });
});
