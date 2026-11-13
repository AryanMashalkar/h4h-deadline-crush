// npm run seed -- [--teams 2000] [--deadline-minutes 10] [--grace-seconds 900] [--tokens ../loadtest/tokens.json]
// Creates a hackathon with N teams (one member each) plus an organizer, and
// optionally writes JWTs for the load test. Organizer login is printed.
import { writeFile } from 'node:fs/promises';
import { hashPassword, issueToken } from '../src/auth.js';
import { createPool, migrate } from '../src/db.js';

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const teams = Number(arg('teams', '2000'));
const minutes = Number(arg('deadline-minutes', '10'));
const grace = Number(arg('grace-seconds', '900'));
const tokensFile = arg('tokens', '');
const name = arg('name', `Load test ${new Date().toISOString().slice(0, 16)}`);
const orgPassword = arg('organizer-password', 'organizer-demo-2026');

const pool = createPool(undefined, 4);
await migrate(pool);
const pw = await hashPassword('participant-demo-2026');
const h = await pool.query(
  `INSERT INTO hackathons (name, deadline, grace_seconds) VALUES ($1, clock_timestamp() + make_interval(mins => $2), $3) RETURNING id, deadline`,
  [name, minutes, grace],
);
const hackathonId: string = h.rows[0].id;
const tag = hackathonId.slice(0, 8);
const users = await pool.query(
  `INSERT INTO users (email, name, password_hash)
   SELECT 'team' || g || '-' || $2 || '@load.test', 'Builder ' || g, $1 FROM generate_series(1, $3) g RETURNING id, name`,
  [pw, tag, teams],
);
const ids = users.rows.map((u) => u.id as string);
const t = await pool.query(
  `INSERT INTO teams (hackathon_id, name) SELECT $1, 'Team ' || g FROM generate_series(1, $2) g RETURNING id, name`,
  [hackathonId, teams],
);
const teamIds = t.rows.sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5))).map((r) => r.id as string);
await pool.query(
  `INSERT INTO team_members (team_id, hackathon_id, user_id) SELECT unnest($1::uuid[]), $2, unnest($3::uuid[])`,
  [teamIds, hackathonId, users.rows.sort((a, b) => Number(a.name.slice(8)) - Number(b.name.slice(8))).map((u) => u.id)],
);
const orgEmail = `organizer-${tag}@load.test`;
const org = await pool.query(
  "INSERT INTO users (email, name, password_hash, role, organizer_of) VALUES ($1, 'Organizer', $2, 'organizer', $3) RETURNING id",
  [orgEmail, await hashPassword(orgPassword), hackathonId],
);

if (tokensFile) {
  const members = await pool.query('SELECT team_id, user_id FROM team_members WHERE hackathon_id = $1', [hackathonId]);
  const out = await Promise.all(
    members.rows.map(async (m) => ({ teamId: m.team_id, token: await issueToken({ userId: m.user_id, role: 'participant' }, 6 * 3600) })),
  );
  const organizerToken = await issueToken({ userId: org.rows[0].id, role: 'organizer' }, 6 * 3600);
  await writeFile(tokensFile, JSON.stringify({ hackathonId, deadline: h.rows[0].deadline, organizerToken, teams: out }));
}
await pool.end();
console.log(JSON.stringify({ hackathonId, teams: ids.length, deadline: h.rows[0].deadline, organizer: { email: orgEmail, password: orgPassword } }, null, 2));
