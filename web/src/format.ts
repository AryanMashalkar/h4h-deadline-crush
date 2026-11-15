export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function clock(ms: number): string {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${neg ? '−' : ''}${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function whenMs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export const STATUS_LABEL: Record<string, string> = {
  uploading: 'Uploading',
  checking: 'Checking',
  accepted: 'Accepted',
  needs_fix: 'Needs a fix',
  rejected: 'Rejected',
};

export const CHECK_LABEL: Record<string, string> = {
  file: 'File present',
  integrity: 'Bytes match the hash you declared',
  file_type: 'File type (by content)',
  archive: 'Archive safety',
  malware: 'Virus & executable signature scan',
  preview: 'Preview',
  links: 'Links respond',
};
