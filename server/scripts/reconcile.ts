// npm run reconcile -- [hackathonId] [--out file.json]
// Exits non-zero if anything is lost.
import { writeFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { reconcile } from '../src/reconcile.js';
import { Storage } from '../src/storage.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
const hackathonId = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1);
const pool = createPool(undefined, 4);
const report = await reconcile(pool, new Storage(), hackathonId);
await pool.end();
const summary = { ...report, missing: report.missing.slice(0, 20), sizeMismatch: report.sizeMismatch.slice(0, 20) };
console.log(JSON.stringify(summary, null, 2));
if (out) await writeFile(out, JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
