import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { hashPassword, issueToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { EventHub } from '../src/events.js';
import { Storage } from '../src/storage.js';

export const TEST_DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crush_test';

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;
  hub: EventHub;
  storage: Storage;
  baseUrl: string;
  close(): Promise<void>;
}

/** A real server on a random port; uploads go to the real S3-compatible store. */
export async function startHarness(): Promise<Harness> {
  const pool = createPool(TEST_DB, 40);
  const hub = new EventHub(TEST_DB);
  await hub.start();
  const storage = new Storage();
  const app = await buildApp({ pool, hub, storage, limits: { globalPerIp: 1_000_000, authPerIp: 1_000_000 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    pool,
    hub,
    storage,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      await hub.stop();
      await pool.end();
    },
  };
}

let pwHash: string | undefined;

export interface Fixture {
  hackathonId: string;
  teamId: string;
  token: string;
  userId: string;
  otherToken: string; // member of a different team
  otherTeamId: string;
  organizerToken: string;
}

/** A hackathon whose deadline is `deadlineInMs` from now (DB clock), with two teams and an organizer. */
export async function fixture(pool: pg.Pool, deadlineInMs = 60 * 60 * 1000, graceSeconds = 900): Promise<Fixture> {
  pwHash ??= await hashPassword('password123');
  const s = randomUUID().slice(0, 8);
  const h = await pool.query(
    `INSERT INTO hackathons (name, deadline, grace_seconds) VALUES ($1, clock_timestamp() + make_interval(secs => $2::double precision / 1000), $3) RETURNING id`,
    [`H ${s}`, deadlineInMs, graceSeconds],
  );
  const hackathonId = h.rows[0].id;
  const mk = async (name: string, role = 'participant') =>
    (await pool.query('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [`${name}-${s}@t.test`, name, pwHash, role])).rows[0].id as string;
  const team = async (name: string, userId: string) => {
    const t = (await pool.query('INSERT INTO teams (hackathon_id, name) VALUES ($1, $2) RETURNING id', [hackathonId, `${name} ${s}`])).rows[0].id;
    await pool.query('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1, $2, $3)', [t, hackathonId, userId]);
    return t as string;
  };
  const userId = await mk('alice');
  const otherId = await mk('bob');
  const orgId = await mk('org', 'organizer');
  return {
    hackathonId,
    userId,
    teamId: await team('Alpha', userId),
    otherTeamId: await team('Beta', otherId),
    token: await issueToken({ userId, role: 'participant' }),
    otherToken: await issueToken({ userId: otherId, role: 'participant' }),
    organizerToken: await issueToken({ userId: orgId, role: 'organizer' }),
  };
}

export async function setDeadline(pool: pg.Pool, hackathonId: string, offsetMs: number, graceSeconds?: number) {
  await pool.query(
    `UPDATE hackathons SET deadline = clock_timestamp() + make_interval(secs => $2::double precision / 1000),
            grace_seconds = COALESCE($3, grace_seconds) WHERE id = $1`,
    [hackathonId, offsetMs, graceSeconds ?? null],
  );
}

export function api(baseUrl: string, token?: string) {
  return async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function details(over: Record<string, unknown> = {}) {
  return { title: 'My project', description: 'It does things', links: [], ...over };
}

/** Starts an upload, PUTs every part straight to storage, returns what complete() needs. */
export async function uploadParts(call: ReturnType<typeof api>, teamId: string, file: Buffer, opts: { fileName?: string; sha?: string; links?: string[]; clientKey?: string } = {}) {
  const start = await call('POST', `/api/teams/${teamId}/uploads`, {
    ...details({ links: opts.links ?? [] }),
    clientKey: opts.clientKey ?? randomUUID(),
    fileName: opts.fileName ?? 'project.pdf',
    contentType: 'application/octet-stream',
    size: file.length,
    sha256: opts.sha ?? sha256(file),
  });
  if (start.status !== 201 && start.status !== 200) return { start, parts: [] as { partNumber: number; etag: string }[] };
  const s = start.body;
  const nums = Array.from({ length: s.partCount }, (_, i) => i + 1);
  const signed = await call('POST', `/api/teams/${teamId}/uploads/${s.id}/parts`, { partNumbers: nums });
  if (signed.status !== 200) return { start, signed, parts: [] };
  const parts = await Promise.all(
    signed.body.urls.map(async ({ partNumber, url }: { partNumber: number; url: string }) => {
      const chunk = file.subarray((partNumber - 1) * s.partSize, partNumber * s.partSize);
      const res = await fetch(url, { method: 'PUT', body: chunk });
      if (!res.ok) throw new Error(`part ${partNumber} PUT failed: ${res.status} ${await res.text()}`);
      return { partNumber, etag: res.headers.get('etag')! };
    }),
  );
  return { start, signed, parts };
}

export async function uploadFile(call: ReturnType<typeof api>, teamId: string, file: Buffer, opts: Parameters<typeof uploadParts>[3] = {}) {
  const up = await uploadParts(call, teamId, file, opts);
  if (!up.parts.length) return { ...up, complete: null as any };
  const complete = await call('POST', `/api/teams/${teamId}/uploads/${up.start.body.id}/complete`, { parts: up.parts });
  return { ...up, complete };
}

/** Polls the DB until every job is done or dead. */
export async function waitForJobs(pool: pg.Pool, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running')");
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('jobs did not finish in time');
}

/** A minimal valid one-page PDF. */
export function tinyPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 24 Tf 30 100 Td (Deadline Crush) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
