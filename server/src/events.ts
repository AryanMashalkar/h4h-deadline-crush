import pg from 'pg';
import { sslFor, type Tx } from './db.js';

/**
 * Live status. Events are sent with pg_notify inside the same transaction as
 * the change, so they are delivered only if it commits. Every process LISTENs
 * and fans out to its own SSE clients, so API and workers can be separate.
 */
export const CHANNEL = 'crush_events';

export type DomainEvent =
  | { type: 'upload.started' | 'upload.completed' | 'upload.aborted'; hackathonId: string; teamId: string; uploadId: string }
  | { type: 'version.created' | 'version.checked'; hackathonId: string; teamId: string; versionId: string; status: string }
  | { type: 'late.attempt'; hackathonId: string; teamId: string | null };

export async function publish(tx: Tx | pg.Pool, event: DomainEvent): Promise<void> {
  await tx.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(event)]);
}

export function topicsFor(e: DomainEvent): string[] {
  const topics = [`hackathon:${e.hackathonId}`];
  if (e.teamId) topics.push(`team:${e.teamId}`);
  return topics;
}

type Handler = (e: DomainEvent) => void;

export class EventHub {
  private subs = new Map<string, Set<Handler>>();
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(private readonly databaseUrl: string) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl, ssl: sslFor(this.databaseUrl) });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        this.dispatch(JSON.parse(msg.payload) as DomainEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    client.on('error', () => this.reconnect(client));
    client.on('end', () => this.reconnect(client));
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
  }

  private reconnect(old: pg.Client) {
    if (this.stopped || (this.client !== null && this.client !== old)) return;
    this.client = null;
    setTimeout(() => {
      if (!this.stopped) this.connect().catch(() => this.reconnect(old));
    }, 1000).unref();
  }

  dispatch(e: DomainEvent) {
    for (const topic of topicsFor(e)) for (const h of this.subs.get(topic) ?? []) h(e);
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subs.delete(topic);
    };
  }

  get subscriberCount(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => {});
  }
}
