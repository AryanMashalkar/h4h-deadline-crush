-- Deadline Crush schema.
-- Every rule that decides whether a submission counts lives in the database:
-- the deadline check (submission_window), version numbering, one result per
-- check per version, and the job lease fence. The API and workers only call it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'organizer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE hackathons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  deadline       timestamptz NOT NULL,
  -- Uploads started before the deadline may finish within this many seconds after it.
  grace_seconds  integer NOT NULL DEFAULT 900 CHECK (grace_seconds BETWEEN 0 AND 3600),
  max_file_bytes bigint NOT NULL DEFAULT 104857600 CHECK (max_file_bytes > 0),
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Organizers see every hackathon, unless scoped to one (demo organizers).
ALTER TABLE users ADD COLUMN organizer_of uuid REFERENCES hackathons(id) ON DELETE CASCADE;

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id uuid NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Version numbers are handed out by an atomic increment on this row, so two
  -- members saving at the same instant get distinct, ordered numbers.
  version_seq  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_key ON teams (hackathon_id, lower(name));

CREATE TABLE team_members (
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id uuid NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id),
  UNIQUE (hackathon_id, user_id)
);

-- An upload in progress. started_at is taken from the database clock and is
-- the moment that decides whether the upload is on time.
CREATE TABLE upload_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id    uuid NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES users(id),
  client_key      text NOT NULL,
  file_name       text NOT NULL,
  content_type    text NOT NULL,
  declared_size   bigint NOT NULL CHECK (declared_size > 0),
  declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  part_size       integer NOT NULL CHECK (part_size >= 5242880),
  part_count      integer NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  -- Project details are captured when the upload starts, so nothing about the
  -- submission can change after the deadline, only the bytes can finish arriving.
  title           text NOT NULL,
  description     text NOT NULL,
  links           jsonb NOT NULL DEFAULT '[]',
  object_key      text NOT NULL UNIQUE,
  s3_upload_id    text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'aborted', 'expired')),
  started_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at    timestamptz,
  UNIQUE (team_id, client_key)
);
CREATE INDEX upload_sessions_open ON upload_sessions (hackathon_id) WHERE status = 'open';

-- Append-only: a version is never updated except for its check outcome.
CREATE TABLE versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id      uuid NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  version_no        integer NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  client_key        text NOT NULL,
  title             text NOT NULL,
  description       text NOT NULL,
  links             jsonb NOT NULL DEFAULT '[]',
  upload_session_id uuid UNIQUE REFERENCES upload_sessions(id),
  object_key        text,
  file_name         text,
  file_size         bigint,
  declared_sha256   text,
  -- The time that counts for the deadline: when the upload started, or when
  -- the edit was saved for a version that reuses the previous file.
  effective_at      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  in_grace          boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'checking'
                    CHECK (status IN ('checking', 'accepted', 'needs_fix', 'rejected')),
  status_reason     text,
  sha256            text,
  detected_type     text,
  preview_key       text,
  preview_text      text,
  checked_at        timestamptz,
  UNIQUE (team_id, version_no),
  UNIQUE (team_id, client_key),
  CHECK (effective_at <= created_at)
);
CREATE INDEX versions_hackathon ON versions (hackathon_id, team_id, version_no DESC);

-- One row per check per version. The primary key is what makes a retried job
-- unable to record a second result.
CREATE TABLE check_results (
  version_id uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  check_name text NOT NULL,
  ok         boolean NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  job_id     bigint NOT NULL,
  attempt    integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, check_name)
);

-- Receipt per accepted file: the SHA-256 the worker computed while streaming.
CREATE TABLE receipts (
  version_id uuid PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
  sha256     text NOT NULL,
  size       bigint NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Postgres job queue. A job is claimed with FOR UPDATE SKIP LOCKED and held by
-- a lease; lease_token is a fencing token checked when results are written.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  version_id   uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token  uuid,
  lease_until  timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  UNIQUE (kind, version_id)
);
CREATE INDEX jobs_ready ON jobs (run_after, id) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs (lease_until) WHERE status = 'running';

-- Every attempt refused because of the deadline, for the organizer dashboard.
CREATE TABLE late_attempts (
  id           bigserial PRIMARY KEY,
  hackathon_id uuid NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  team_id      uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX late_attempts_hackathon ON late_attempts (hackathon_id);

-- The deadline policy, in one place. Times are always the database clock.
--   action 'start'    : open an upload or save an edit. Allowed only before the deadline.
--   action 'transfer' : sign part URLs or complete an upload. Allowed before the
--                       deadline, or until deadline + grace if the upload started
--                       before the deadline.
-- The deadline itself is exclusive: at exactly 23:59:59.000000 the window is closed.
CREATE FUNCTION submission_window(
  p_deadline timestamptz, p_grace_seconds integer, p_action text,
  p_started_at timestamptz, p_now timestamptz
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_now < p_deadline THEN 'open'
    WHEN p_action = 'transfer'
         AND p_started_at IS NOT NULL
         AND p_started_at < p_deadline
         AND p_now < p_deadline + make_interval(secs => p_grace_seconds) THEN 'grace'
    ELSE 'closed'
  END
$$;

-- The version that counts: the newest version that is not rejected. Versions can
-- only be created inside the window, so "newest" is also "last before the deadline".
CREATE VIEW counted_versions AS
SELECT DISTINCT ON (team_id) *
  FROM versions
 WHERE status <> 'rejected'
 ORDER BY team_id, version_no DESC;
