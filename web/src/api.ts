// Small API client. Network failures are retried with backoff; every write the
// client sends is idempotent on the server (client keys, completed-upload
// replay), so a retry can never submit twice.

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function store(key: string) {
  let memory: string | null = null;
  return {
    get(): string | null {
      try {
        return localStorage.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(v: string | null) {
      memory = v;
      try {
        if (v) localStorage.setItem(key, v);
        else localStorage.removeItem(key);
      } catch {
        /* private mode: kept in memory only */
      }
    },
  };
}

export const tokens = {
  participant: store('crush.token.participant'),
  organizer: store('crush.token.organizer'),
  active: store('crush.token.active'), // 'participant' | 'organizer'
};

export function currentToken(): string | null {
  const which = tokens.active.get() === 'organizer' ? tokens.organizer : tokens.participant;
  return which.get() ?? tokens.participant.get() ?? tokens.organizer.get();
}

export function signOut() {
  tokens.participant.set(null);
  tokens.organizer.set(null);
  tokens.active.set(null);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function request<T>(method: string, path: string, body?: unknown, token = currentToken()): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      if (attempt < 4) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw { status: 0, code: 'OFFLINE', message: 'You seem to be offline. We will keep trying when you reconnect.' } as ApiError;
    }
    if ((res.status === 503 || res.status === 502 || res.status === 504) && attempt < 4) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw { status: res.status, code: data?.error?.code ?? 'ERROR', message: data?.error?.message ?? 'Request failed', details: data?.error?.details } as ApiError;
    }
    return data as T;
  }
}

export const get = <T>(p: string) => request<T>('GET', p);
export const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);
export const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
export const del = <T>(p: string) => request<T>('DELETE', p);

/** Authenticated download of a non-JSON response (CSV, .eml) as a file. */
export async function downloadFile(path: string, filename: string) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${currentToken()}` } });
  if (!res.ok) throw { status: res.status, code: 'ERROR', message: 'Download failed' } as ApiError;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function eventsUrl(path: string) {
  return `${path}?access_token=${encodeURIComponent(currentToken() ?? '')}`;
}

// ------------------------------------------------------------------ types

export interface Check {
  name: string;
  ok: boolean;
  detail: Record<string, any>;
}
export interface Version {
  id: string;
  versionNo: number;
  title: string;
  description: string;
  links: string[];
  file: { name: string; size: number; declaredSha256: string } | null;
  effectiveAt: string;
  createdAt: string;
  inGrace: boolean;
  status: 'checking' | 'accepted' | 'needs_fix' | 'rejected';
  statusReason: string | null;
  sha256: string | null;
  detectedType: string | null;
  hasPreview: boolean;
  previewText: string | null;
  checks: Check[];
  createdBy: string;
}
export interface UploadSession {
  id: string;
  status: string;
  fileName: string;
  size: number;
  partSize: number;
  partCount: number;
  startedAt: string;
  finishBy: string;
}
export interface Submission {
  team: { id: string; name: string; hackathonId: string };
  deadline: string;
  graceSeconds: number;
  maxFileBytes: number;
  serverTime: string;
  countedVersionId: string | null;
  uploads: UploadSession[];
  versions: Version[];
}
export interface Me {
  user: { id: string; email: string; name: string; role: 'participant' | 'organizer'; organizer_of: string | null };
  teams: { id: string; name: string; hackathon_id: string; hackathon_name: string; deadline: string; grace_seconds: number }[];
  hackathons: { id: string; name: string; deadline: string; grace_seconds: number }[];
}
export interface Stats {
  hackathon: { id: string; name: string; deadline: string; graceSeconds: number; isDemo: boolean };
  serverTime: string;
  teams: number;
  teamsSubmitted: number;
  counted: { accepted: number; checking: number; needsFix: number };
  versions: number;
  rejectedVersions: number;
  graceVersions: number;
  uploadsInProgress: number;
  lateAttempts: number;
  versionsFailedChecks: number;
  failedByCheck: Record<string, number>;
  jobs: { queued: number; running: number; done: number; dead: number; retried: number; fencedOut: number };
  receiptsEmailed: number;
  chaosArmed: boolean;
  perMinute: { minute: string; n: number }[];
}
