-- Emailed receipts: one outbox row per accepted version, written in the same
-- transaction as the receipt, so a receipt can never exist without its email
-- (or the reverse). A sender delivers each row once, keyed by idempotency_key.
CREATE TABLE email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      uuid NOT NULL UNIQUE REFERENCES versions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  to_addresses    text[] NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at         timestamptz
);

-- Demo-only fault injection: the next check job of this hackathon simulates a
-- worker that freezes mid-job, loses its lease and later tries to commit.
ALTER TABLE hackathons ADD COLUMN chaos_pending boolean NOT NULL DEFAULT false;
-- Commits refused by the lease fence (a "zombie" worker's late write).
ALTER TABLE jobs ADD COLUMN fenced_out integer NOT NULL DEFAULT 0;
