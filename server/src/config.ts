function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}
const bool = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw === 'true' || raw === '1';
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = process.env.JWT_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-only-secret-change-me-0123456789');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');

export const config = {
  nodeEnv,
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL ?? '',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crush',
  dbPoolSize: int('DB_POOL_SIZE', 20),
  jwtSecret,
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 24),

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:3900',
    // Browsers may need a different host for the same bucket (e.g. Docker networks).
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? 'http://localhost:3900',
    region: process.env.S3_REGION ?? 'garage',
    bucket: process.env.S3_BUCKET ?? 'submissions',
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    // Apply CORS to the bucket on boot so browsers can PUT parts and read ETag.
    configureCors: bool('S3_CONFIGURE_CORS', true),
  },
  /** Part URLs live this long, and never past deadline + grace. */
  partUrlTtlSeconds: int('PART_URL_TTL_SECONDS', 600),
  downloadUrlTtlSeconds: int('DOWNLOAD_URL_TTL_SECONDS', 300),
  partSize: int('PART_SIZE_BYTES', 10 * 1024 * 1024),
  maxOpenUploadsPerTeam: int('MAX_OPEN_UPLOADS_PER_TEAM', 3),

  worker: {
    inProcess: bool('WORKER_IN_PROCESS', true),
    concurrency: int('WORKER_CONCURRENCY', 2),
    leaseSeconds: int('JOB_LEASE_SECONDS', 30),
    pollMs: int('JOB_POLL_MS', 500),
    linkTimeoutMs: int('LINK_TIMEOUT_MS', 5000),
    // Tests point links at a local server; never set this in production.
    allowPrivateLinks: bool('ALLOW_PRIVATE_LINKS', false),
  },

  rateGlobalPerIp: int('RATE_GLOBAL_PER_IP', 1200),
  rateAuthPerIp: int('RATE_AUTH_PER_IP', 30),
  webDist: process.env.WEB_DIST ?? '',
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
};
