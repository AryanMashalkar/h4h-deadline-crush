import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';

/**
 * Link checker that cannot be pointed at the inside of our network (SSRF).
 * - only http/https on ports 80/443
 * - every resolved address must be public unicast (no loopback, private,
 *   link-local such as 169.254.169.254 cloud metadata, CGNAT, multicast...)
 * - the address we validated is the one we connect to (lookup hook), so DNS
 *   rebinding between check and connect does not work
 * - redirects are followed by hand, re-checking every hop, at most 3
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}

export class BlockedAddress extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to a non-public address (${address})`);
  }
}

function makeAgent(allowPrivate: boolean, timeoutMs: number) {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      lookup(hostname: string, options: any, cb: (...args: any[]) => void) {
        dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
          if (err) return cb(err);
          const bad = addresses.find((a) => !isPublicAddress(a.address));
          if (bad && !allowPrivate) return cb(new BlockedAddress(hostname, bad.address));
          if (options?.all) return cb(null, addresses);
          cb(null, addresses[0]!.address, addresses[0]!.family);
        });
      },
    },
  });
}

export interface LinkResult {
  url: string;
  ok: boolean;
  status?: number;
  finalUrl?: string;
  error?: string;
  ms: number;
}

export async function checkLink(url: string, opts: { timeoutMs: number; allowPrivate: boolean }): Promise<LinkResult> {
  const started = Date.now();
  const agent = makeAgent(opts.allowPrivate, opts.timeoutMs);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const u = new URL(current);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail(`unsupported scheme ${u.protocol}`);
      if (u.username || u.password) return fail('links with credentials are not allowed');
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      if (!opts.allowPrivate && port !== 80 && port !== 443) return fail(`port ${port} is not allowed`);
      // IP literals never reach the lookup hook, so check them here.
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (ipaddr.isValid(host) && !opts.allowPrivate && !isPublicAddress(host)) return fail(`address ${host} is not public`);

      let res = await request(current, {
        method: 'HEAD',
        dispatcher: agent,
        signal,
        headers: { 'user-agent': 'DeadlineCrush-LinkCheck/1.0' },
      });
      await res.body.dump();
      if (res.statusCode === 405 || res.statusCode === 501 || res.statusCode === 403) {
        // Some servers refuse HEAD; ask for the page but read no more than 64 KB.
        res = await request(current, {
          method: 'GET',
          dispatcher: agent,
          signal,
          headers: { 'user-agent': 'DeadlineCrush-LinkCheck/1.0' },
        });
        await res.body.dump({ limit: 64 * 1024 });
      }
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && typeof location === 'string') {
        current = new URL(location, current).toString();
        continue;
      }
      const ok = res.statusCode < 400;
      return {
        url,
        ok,
        status: res.statusCode,
        finalUrl: current,
        ms: Date.now() - started,
        error: ok ? undefined : res.statusCode === 401 || res.statusCode === 403 ? 'needs a login: judges cannot open it' : `HTTP ${res.statusCode}`,
      };
    }
    return fail('too many redirects');
  } catch (err) {
    const e = err as Error & { cause?: Error };
    const msg = e instanceof BlockedAddress || e.cause instanceof BlockedAddress ? (e.cause ?? e).message : e.name === 'TimeoutError' ? 'timed out' : e.message;
    return fail(msg);
  } finally {
    await agent.close().catch(() => {});
  }

  function fail(error: string): LinkResult {
    return { url, ok: false, error, ms: Date.now() - started };
  }
}
