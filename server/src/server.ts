import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { EventHub } from './events.js';
import { Storage } from './storage.js';
import { Worker } from './worker/worker.js';

const pool = createPool();
await migrate(pool);
const storage = new Storage();
if (config.s3.configureCors) {
  const origins = config.publicUrl ? [config.publicUrl] : ['*'];
  await storage.configureCors(origins).catch((err) => console.error('could not set bucket CORS (set it by hand):', err.message));
}
const hub = new EventHub(config.databaseUrl);
await hub.start();
const app = await buildApp({ pool, hub, storage });

// On a single free instance the worker runs inside the API process. With
// WORKER_IN_PROCESS=false, run `npm run start:worker` as separate processes.
let worker: Worker | undefined;
if (config.worker.inProcess) {
  worker = new Worker({ pool, storage, logger: app.log as never });
  worker.start();
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await worker?.stop();
  await hub.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
