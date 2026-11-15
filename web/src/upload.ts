import { createSHA256 } from 'hash-wasm';
import { request, sleep, type ApiError, type UploadSession, type Version } from './api';

/**
 * Resumable upload straight to object storage.
 *
 * 1. Hash the file locally (SHA-256). The hash is sent when the upload starts,
 *    i.e. before the deadline; the worker later checks the bytes match it. That
 *    is what makes the grace period fair: it buys transfer time, not work time.
 * 2. Start an upload session. Its clientKey is remembered per file until the
 *    upload finishes, so asking again (retry, reload) returns the same session.
 * 3. PUT fixed-size parts to short-lived signed URLs, 4 at a time. Each part
 *    is retried on failure; when the browser goes offline we wait for it to
 *    come back. Finished part ETags are saved in localStorage, and the server
 *    can list stored parts, so a reload resumes instead of restarting.
 * 4. Complete. Safe to repeat: the server returns the same version.
 */

export type Phase = 'hashing' | 'starting' | 'uploading' | 'finishing' | 'done' | 'paused' | 'offline' | 'failed';

export interface Progress {
  phase: Phase;
  hashed: number; // 0..1
  sent: number; // bytes confirmed
  total: number;
  partsDone: number;
  partCount: number;
  error?: string;
  session?: UploadSession;
  version?: Version;
  resumed?: boolean;
  /** One entry per 10 MiB part: kept = already in storage when this run started (resume). */
  parts?: PartState[];
}

export type PartState = 'todo' | 'sending' | 'done' | 'kept';

interface Saved {
  clientKey: string;
  sessionId?: string;
  etags: Record<number, string>;
}

const CONCURRENCY = 4;
const SIGN_BATCH = 16;

function load(key: string): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(`crush.upload.${key}`) ?? 'null');
  } catch {
    return null;
  }
}
function save(key: string, s: Saved | null) {
  try {
    if (s) localStorage.setItem(`crush.upload.${key}`, JSON.stringify(s));
    else localStorage.removeItem(`crush.upload.${key}`);
  } catch {
    /* storage full or blocked: resume after reload just won't be available */
  }
}

export async function sha256OfFile(file: File, onProgress: (f: number) => void, signal: AbortSignal): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const step = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += step) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    hasher.update(new Uint8Array(await file.slice(off, off + step).arrayBuffer()));
    onProgress(Math.min(1, (off + step) / file.size));
  }
  onProgress(1);
  return hasher.digest('hex');
}

// Hashing starts the moment a file is chosen, not when "Upload" is pressed, so a
// team clicking with seconds left only waits for the server call: the hash that
// fixes the content before the deadline is usually ready already.
const prehashed = new WeakMap<File, Promise<string>>();
export function prehash(file: File, onProgress: (f: number) => void = () => {}): Promise<string> {
  let p = prehashed.get(file);
  if (!p) {
    p = sha256OfFile(file, onProgress, new AbortController().signal);
    prehashed.set(file, p);
    p.catch(() => prehashed.delete(file));
  }
  return p;
}

function putPart(url: string, blob: Blob, signal: AbortSignal, onBytes: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(Object.assign(new Error(etag ? `storage answered ${xhr.status}` : 'storage hid the ETag header (bucket CORS)'), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('network error'), { status: 0 }));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

const waitOnline = () =>
  navigator.onLine ? Promise.resolve() : new Promise<void>((r) => window.addEventListener('online', () => r(), { once: true }));

export class Upload {
  private ac = new AbortController();
  private inflight = new Map<number, number>();
  private etags: Record<number, string> = {};
  private sha?: string;
  private clientKey?: string;
  private storeKey = '';
  p: Progress;

  constructor(
    private teamId: string,
    readonly file: File,
    private details: { title: string; description: string; links: string[] },
    private onChange: (p: Progress) => void,
  ) {
    this.p = { phase: 'hashing', hashed: 0, sent: 0, total: file.size, partsDone: 0, partCount: 0 };
  }

  private emit(patch: Partial<Progress>) {
    this.p = { ...this.p, ...patch };
    this.onChange(this.p);
  }

  pause() {
    this.ac.abort();
    this.emit({ phase: 'paused' });
  }

  async run(): Promise<Version | undefined> {
    this.ac = new AbortController();
    const signal = this.ac.signal;
    try {
      if (!this.sha) {
        this.emit({ phase: 'hashing' });
        this.sha = await prehash(this.file, (hashed) => this.emit({ hashed }));
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        // Same file after a reload -> same clientKey -> same server session (resume).
        // A finished upload clears this, so submitting the same file again later is a new version.
        this.storeKey = `${this.teamId}.${this.sha}`;
        const prior = load(this.storeKey);
        this.clientKey = prior?.clientKey ?? `f-${this.sha.slice(0, 16)}-${crypto.randomUUID()}`;
        if (!prior) save(this.storeKey, { clientKey: this.clientKey, etags: {} });
      }
      this.emit({ phase: 'starting', hashed: 1 });
      const start = () =>
        request<UploadSession>('POST', `/api/teams/${this.teamId}/uploads`, {
          ...this.details,
          clientKey: this.clientKey,
          fileName: this.file.name.replace(/[\\/]/g, '_').slice(0, 200) || 'file',
          contentType: /^[\w.+-]+\/[\w.+-]+$/.test(this.file.type) ? this.file.type : 'application/octet-stream',
          size: this.file.size,
          sha256: this.sha,
        });
      let session = await start();
      if (session.status !== 'open') {
        // What we remembered is stale (finished, cancelled or expired): begin a fresh upload.
        this.clientKey = `f-${this.sha.slice(0, 16)}-${crypto.randomUUID()}`;
        this.etags = {};
        session = await start();
      }
      // Merge what we remember with what storage actually has.
      const saved = load(this.storeKey);
      if (saved?.sessionId === session.id) Object.assign(this.etags, saved.etags);
      save(this.storeKey, { clientKey: this.clientKey!, sessionId: session.id, etags: this.etags });
      const listed = await request<{ status: string; parts: { partNumber: number; etag: string; size: number }[] }>(
        'GET',
        `/api/teams/${this.teamId}/uploads/${session.id}/parts`,
      ).catch(() => ({ status: 'open', parts: [] }));
      for (const p of listed.parts) this.etags[p.partNumber] ??= p.etag;
      const resumed = Object.keys(this.etags).length > 0;
      const kept = new Set(Object.keys(this.etags).map(Number));
      const view = (): PartState[] =>
        Array.from({ length: session.partCount }, (_, i) =>
          this.etags[i + 1] ? (kept.has(i + 1) ? 'kept' : 'done') : this.inflight.has(i + 1) ? 'sending' : 'todo',
        );
      const partBytes = (n: number) => Math.min(session.partSize, this.file.size - (n - 1) * session.partSize);
      const doneBytes = () => Object.keys(this.etags).reduce((s, n) => s + partBytes(Number(n)), 0);
      this.emit({ phase: 'uploading', session, partCount: session.partCount, partsDone: Object.keys(this.etags).length, sent: doneBytes(), resumed, parts: view() });

      const todo = Array.from({ length: session.partCount }, (_, i) => i + 1).filter((n) => !this.etags[n]);
      const urls = new Map<number, { url: string; until: number }>();
      const urlFor = async (n: number) => {
        const cached = urls.get(n);
        if (cached && cached.until > Date.now() + 15_000) return cached.url;
        const batch = todo.filter((x) => !this.etags[x] && x >= n).slice(0, SIGN_BATCH);
        const res = await request<{ expiresIn: number; urls: { partNumber: number; url: string }[] }>(
          'POST',
          `/api/teams/${this.teamId}/uploads/${session.id}/parts`,
          { partNumbers: batch },
        );
        for (const u of res.urls) urls.set(u.partNumber, { url: u.url, until: Date.now() + res.expiresIn * 1000 });
        return urls.get(n)!.url;
      };

      const queue = [...todo];
      const worker = async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          for (let attempt = 0; ; attempt++) {
            if (signal.aborted) throw new DOMException('aborted', 'AbortError');
            try {
              await waitOnline();
              const url = await urlFor(n);
              const blob = this.file.slice((n - 1) * session.partSize, (n - 1) * session.partSize + partBytes(n));
              const etag = await putPart(url, blob, signal, (b) => {
                this.inflight.set(n, b);
                this.emit({ sent: doneBytes() + [...this.inflight.values()].reduce((a, c) => a + c, 0), parts: view() });
              });
              this.inflight.delete(n);
              this.etags[n] = etag;
              save(this.storeKey, { clientKey: this.clientKey!, sessionId: session.id, etags: this.etags });
              this.emit({ partsDone: Object.keys(this.etags).length, sent: doneBytes() + [...this.inflight.values()].reduce((a, c) => a + c, 0), parts: view() });
              break;
            } catch (err) {
              this.inflight.delete(n);
              this.emit({ parts: view() });
              if ((err as Error).name === 'AbortError') throw err;
              const apiErr = err as ApiError;
              if (apiErr.code === 'DEADLINE_PASSED' || apiErr.code === 'UPLOAD_NOT_OPEN') throw err;
              if ((err as { status?: number }).status === 403) urls.delete(n); // URL expired: sign again
              if (!navigator.onLine) this.emit({ phase: 'offline' });
              if (attempt >= 8) throw err;
              await sleep(Math.min(15_000, 500 * 2 ** attempt));
              if (navigator.onLine) this.emit({ phase: 'uploading' });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));

      this.emit({ phase: 'finishing' });
      const parts = Object.entries(this.etags)
        .map(([n, etag]) => ({ partNumber: Number(n), etag }))
        .sort((a, b) => a.partNumber - b.partNumber);
      const version = await request<Version>('POST', `/api/teams/${this.teamId}/uploads/${session.id}/complete`, { parts });
      save(this.storeKey, null);
      this.emit({ phase: 'done', version, sent: this.file.size, partsDone: session.partCount, parts: view() });
      return version;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return undefined;
      this.emit({ phase: 'failed', error: (err as ApiError).message ?? (err as Error).message });
      return undefined;
    }
  }
}
