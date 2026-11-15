import type pg from 'pg';
import { config } from './config.js';
import { withTx } from './db.js';

/**
 * Delivers queued receipt emails (email_outbox) through Resend's HTTP API.
 * Rows are claimed with SKIP LOCKED, so several workers never send the same
 * row at once, and each request carries the row's idempotency_key, so a crash
 * between "sent" and "marked sent" does not email twice. Addresses on the
 * reserved .invalid domain (demo accounts) are marked done without sending.
 */
export async function sendPendingReceipts(
  pool: pg.Pool,
  opts: { apiKey?: string; url?: string; from?: string; batch?: number } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  const apiKey = opts.apiKey ?? config.mail.resendApiKey;
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!apiKey) return out;
  await withTx(pool, async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, idempotency_key, to_addresses, subject, body FROM email_outbox
        WHERE sent_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [opts.batch ?? 20],
    );
    for (const r of rows) {
      const to = (r.to_addresses as string[]).filter((a) => !/\.invalid$/i.test(a));
      let ok = to.length === 0;
      if (to.length) {
        const res = await fetch(opts.url ?? config.mail.resendUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': r.idempotency_key },
          body: JSON.stringify({ from: opts.from ?? config.mail.from, to, subject: r.subject, text: r.body }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        ok = !!res?.ok;
      }
      if (ok) {
        await tx.query('UPDATE email_outbox SET sent_at = clock_timestamp() WHERE id = $1', [r.id]);
        if (to.length) out.sent++;
        else out.skipped++;
      } else out.failed++;
    }
  });
  return out;
}
