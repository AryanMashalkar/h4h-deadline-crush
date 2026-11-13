import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { ZodError } from 'zod';
import { hashPassword, issueToken, verifyPassword, verifyToken, type Principal } from './auth.js';
import { config } from './config.js';
import { withTx } from './db.js';
import { AppError, PG, notFound, pgCode } from './errors.js';
import { EventHub, type DomainEvent } from './events.js';
import { Metrics } from './metrics.js';
import * as O from './services/organizer.js';
import * as S from './services/submissions.js';
import type { Storage } from './storage.js';
import * as V from './validation.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppDeps {
  pool: pg.Pool;
  hub: EventHub;
  storage: Storage;
  limits?: Partial<{ globalPerIp: number; authPerIp: number }>;
}

export async function buildApp({ pool, hub, storage, limits: overrides }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 64 * 1024 * 4, // part lists for 10,000 parts; file bytes never come here
    genReqId: () => randomUUID(),
  });
  const metrics = new Metrics();
  const limits = {
    globalPerIp: overrides?.globalPerIp ?? config.rateGlobalPerIp,
    authPerIp: overrides?.authPerIp ?? config.rateAuthPerIp,
  };

  await app.register(cors, { origin: config.nodeEnv === 'production' ? false : true });
  await app.register(rateLimit, {
    global: true,
    max: limits.globalPerIp,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/api/health'),
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s` },
    }),
  });

  app.addHook('onResponse', async (req, reply) => {
    metrics.observe(req.routeOptions.url ?? 'unknown', req.method, reply.statusCode, reply.elapsedTime);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(err);
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    if (pgCode(err) === PG.lockNotAvailable) {
      return reply.status(503).header('retry-after', '1').send({ error: { code: 'BUSY', message: 'Busy, please retry' } });
    }
    if (pgCode(err) === '22P02') return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Malformed identifier' } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  async function authenticate(req: FastifyRequest) {
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header?.startsWith('Bearer ')) token = header.slice(7);
    // EventSource cannot set headers, so SSE endpoints accept ?access_token=.
    else if (req.url.includes('/events')) token = (req.query as { access_token?: string }).access_token;
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in first');
    req.principal = await verifyToken(token);
  }
  const me = (req: FastifyRequest): S.Actor => req.principal!;
  const idParam = (req: FastifyRequest, name = 'id') => V.uuid.parse((req.params as Record<string, string>)[name]);

  // -------------------------------------------------------------- public
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });
  app.get('/api/time', async () => {
    const { rows } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return { serverTime: rows[0]!.now.toISOString() };
  });
  app.get('/api/metrics', async (_req, reply) => {
    const { rows } = await pool.query(`SELECT
      (SELECT count(*) FROM jobs WHERE status = 'queued')::int AS queued,
      (SELECT count(*) FROM jobs WHERE status = 'running')::int AS running,
      (SELECT count(*) FROM jobs WHERE status = 'dead')::int AS dead`);
    reply.type('text/plain; version=0.0.4');
    return metrics.render({
      jobs_queued: rows[0].queued,
      jobs_running: rows[0].running,
      jobs_dead: rows[0].dead,
      sse_subscribers: hub.subscriberCount,
      db_pool_waiting: pool.waitingCount,
    });
  });

  const authLimit = { config: { rateLimit: { max: limits.authPerIp, timeWindow: '1 minute' } } };

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = V.login.parse(req.body);
    const { rows } = await pool.query('SELECT id, password_hash, role FROM users WHERE lower(email) = lower($1)', [body.email]);
    const ok = rows[0] ? await verifyPassword(body.password, rows[0].password_hash) : false;
    if (!ok) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong email or password');
    return { token: await issueToken({ userId: rows[0].id, role: rows[0].role }) };
  });

  /**
   * Demo: creates a private hackathon whose deadline is a few minutes away,
   * one team with one member, and an organizer for that hackathon only. A
   * visitor can upload, watch the deadline pass, try a late upload, and see
   * it all on the organizer dashboard, without touching anyone else's data.
   */
  app.post('/api/demo', authLimit, async (req) => {
    const body = V.demo.parse(req.body ?? {});
    const suffix = randomUUID().slice(0, 6);
    const pw = await hashPassword(randomUUID());
    return withTx(pool, async (tx) => {
      const h = await tx.query(
        `INSERT INTO hackathons (name, deadline, grace_seconds, is_demo)
         VALUES ($1, clock_timestamp() + make_interval(mins => $2), $3, true) RETURNING id`,
        [`Demo ${suffix}`, body.minutes, body.graceSeconds],
      );
      const hackathonId = h.rows[0].id;
      const u = await tx.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
        `builder-${suffix}@demo.invalid`, `Builder ${suffix}`, pw,
      ]);
      const o = await tx.query(
        "INSERT INTO users (email, name, password_hash, role, organizer_of) VALUES ($1, $2, $3, 'organizer', $4) RETURNING id",
        [`organizer-${suffix}@demo.invalid`, `Organizer ${suffix}`, pw, hackathonId],
      );
      const t = await tx.query('INSERT INTO teams (hackathon_id, name) VALUES ($1, $2) RETURNING id', [hackathonId, `Team ${suffix}`]);
      await tx.query('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1, $2, $3)', [t.rows[0].id, hackathonId, u.rows[0].id]);
      return {
        hackathonId,
        teamId: t.rows[0].id,
        participantToken: await issueToken({ userId: u.rows[0].id, role: 'participant' }),
        organizerToken: await issueToken({ userId: o.rows[0].id, role: 'organizer' }),
      };
    });
  });

  // -------------------------------------------------------- authenticated
  app.register(async (r) => {
    r.addHook('onRequest', authenticate);

    r.get('/api/me', async (req) => {
      const { rows: user } = await pool.query('SELECT id, email, name, role, organizer_of FROM users WHERE id = $1', [me(req).userId]);
      if (!user[0]) throw new AppError(401, 'UNAUTHENTICATED', 'Account no longer exists');
      const { rows: teams } = await pool.query(
        `SELECT t.id, t.name, h.id AS hackathon_id, h.name AS hackathon_name, h.deadline, h.grace_seconds
           FROM team_members m JOIN teams t ON t.id = m.team_id JOIN hackathons h ON h.id = t.hackathon_id
          WHERE m.user_id = $1 ORDER BY h.deadline`,
        [me(req).userId],
      );
      const hackathons =
        user[0].role === 'organizer'
          ? (
              await pool.query(
                `SELECT id, name, deadline, grace_seconds FROM hackathons
                  WHERE id = $1 OR ($1::uuid IS NULL AND NOT is_demo) ORDER BY deadline`,
                [user[0].organizer_of],
              )
            ).rows
          : [];
      return { user: user[0], teams, hackathons };
    });

    // ---- team submission
    r.get('/api/teams/:id/submission', async (req) => S.teamSubmission(pool, me(req), idParam(req)));

    r.post('/api/teams/:id/uploads', async (req, reply) => {
      const res = await S.startUpload(pool, storage, me(req), idParam(req), V.startUpload.parse(req.body));
      return reply.status(res.created ? 201 : 200).send(res.session);
    });
    r.post('/api/teams/:id/uploads/:uploadId/parts', async (req) =>
      S.signParts(pool, storage, me(req), idParam(req), idParam(req, 'uploadId'), V.signParts.parse(req.body).partNumbers),
    );
    r.get('/api/teams/:id/uploads/:uploadId/parts', async (req) =>
      S.listUploadedParts(pool, storage, me(req), idParam(req), idParam(req, 'uploadId')),
    );
    r.post('/api/teams/:id/uploads/:uploadId/complete', async (req, reply) => {
      const res = await S.completeUpload(pool, storage, me(req), idParam(req), idParam(req, 'uploadId'), V.completeUpload.parse(req.body).parts);
      if (res.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(res.replayed ? 200 : 201).send(res.version);
    });
    r.delete('/api/teams/:id/uploads/:uploadId', async (req) => S.abortUpload(pool, storage, me(req), idParam(req), idParam(req, 'uploadId')));

    r.post('/api/teams/:id/versions', async (req, reply) => {
      const res = await S.saveDetails(pool, me(req), idParam(req), V.saveDetails.parse(req.body));
      if (res.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(res.replayed ? 200 : 201).send(res.version);
    });
    r.get('/api/versions/:id/download', async (req) => S.versionLink(pool, storage, me(req), idParam(req), 'file'));
    r.get('/api/versions/:id/preview', async (req) => S.versionLink(pool, storage, me(req), idParam(req), 'preview'));

    r.get('/api/teams/:id/events', async (req, reply) => {
      const team = await S.teamFor(pool, me(req), idParam(req), 'read');
      stream(req, reply, `team:${team.id}`);
    });

    // ---- organizers
    r.get('/api/hackathons/:id/stats', async (req) => {
      await S.requireOrganizer(pool, me(req), idParam(req));
      return O.hackathonStats(pool, idParam(req));
    });
    r.get('/api/hackathons/:id/export.csv', async (req, reply) => {
      await S.requireOrganizer(pool, me(req), idParam(req));
      const csv = await O.exportCsv(pool, idParam(req));
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="submissions-${idParam(req)}.csv"`)
        .send(csv);
    });
    r.patch('/api/hackathons/:id', async (req) => {
      await S.requireOrganizer(pool, me(req), idParam(req));
      const body = V.updateHackathon.parse(req.body);
      const { rows } = await pool.query(
        `UPDATE hackathons SET deadline = COALESCE($2::timestamptz, deadline), grace_seconds = COALESCE($3, grace_seconds)
          WHERE id = $1 RETURNING id, name, deadline, grace_seconds`,
        [idParam(req), body.deadline ?? null, body.graceSeconds ?? null],
      );
      if (!rows[0]) throw notFound('Hackathon');
      return rows[0];
    });
    r.get('/api/hackathons/:id/events', async (req, reply) => {
      await S.requireOrganizer(pool, me(req), idParam(req));
      stream(req, reply, `hackathon:${idParam(req)}`);
    });
  });

  function stream(req: FastifyRequest, reply: FastifyReply, topic: string) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const send = (e: DomainEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = hub.subscribe(topic, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  // ------------------------------------------------------------- web UI
  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDist), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such route' } });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
