// Standalone worker process: `npm run worker`. Several can run at once.
import { config } from '../config.js';
import { createPool, migrate } from '../db.js';
import { Storage } from '../storage.js';
import { Worker } from './worker.js';

const pool = createPool(config.databaseUrl, Math.max(4, config.worker.concurrency * 2 + 2));
await migrate(pool);
const worker = new Worker({ pool, storage: new Storage() });
worker.start();
console.log(JSON.stringify({ msg: 'worker started', worker: worker.id, pid: process.pid }));

async function shutdown() {
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
