// Turns a load-test JSON result into the markdown table used in loadtest/README.md.
//   npx tsx scripts/report.ts ../loadtest/results/local-2000-teams-10-min.json
import { readFile } from 'node:fs/promises';

const r = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const nl = r.nothingLost;
const lines = [
  `| | |`,
  `|---|---|`,
  `| Teams | ${r.teams} (${r.onTimeTeams} on time, ${r.lateAttempts} after the deadline) |`,
  `| Window | ${r.windowSeconds} s, back-loaded: cumulative share (t/T)³ |`,
  `| API requests | ${r.api.requests} |`,
  `| **API p95** | **${r.api.p95} ms** (p50 ${r.api.p50} ms, p99 ${r.api.p99} ms, max ${r.api.max} ms) |`,
  `| Uploads completed | ${r.completed} / ${r.onTimeTeams} |`,
  `| Late attempts refused | ${r.lateRefused} / ${r.lateAttempts} (accepted: ${r.lateAccepted}) |`,
  `| Errors | ${Object.keys(r.errors).length === 0 ? 'none' : JSON.stringify(r.errors)} |`,
  `| **Lost submissions** | **${nl.lost}** (worker SHA-256 = client SHA-256 for ${nl.shaMatches} / ${nl.completedUploads}) |`,
  `| Reconciliation | ${nl.reconcile.objectsFound} / ${nl.reconcile.distinctObjects} objects found, ${nl.reconcile.missing.length} missing, ${nl.reconcile.sizeMismatch.length} size mismatches, ${nl.reconcile.completedUploadsWithoutVersion} uploads without a version, ${nl.reconcile.versionsWithoutJob} versions without a job |`,
  `| Checks after the run | ${nl.finalStats.counted.accepted} accepted, ${nl.finalStats.counted.checking} checking, ${nl.finalStats.jobs.dead} dead jobs |`,
  '',
  '| Endpoint | n | p50 ms | p95 ms | p99 ms |',
  '|---|---|---|---|---|',
  ...Object.entries(r.endpoints as Record<string, { n: number; p50: number; p95: number; p99: number }>).map(
    ([k, v]) => `| ${k} | ${v.n} | ${v.p50} | ${v.p95} | ${v.p99} |`,
  ),
];
console.log(lines.join('\n'));
