// Prepares a fresh single-node Garage through its admin API (no CLI or shell
// needed, so it works from any container): layout, bucket, and a key with
// fixed, dev-only credentials. Safe to run again.
//   GARAGE_ADMIN=http://garage:3903 GARAGE_ADMIN_TOKEN=... node dev/garage-bootstrap.mjs
const admin = process.env.GARAGE_ADMIN ?? 'http://localhost:3903';
const token = process.env.GARAGE_ADMIN_TOKEN ?? 'dev-admin-token';
const bucket = process.env.S3_BUCKET ?? 'submissions';
const accessKeyId = process.env.S3_ACCESS_KEY ?? 'GK0000000000000000000000dc';
const secretAccessKey = process.env.S3_SECRET_KEY ?? 'dc'.padEnd(64, '0');

async function call(path, body) {
  const res = await fetch(admin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

for (let i = 0; ; i++) {
  try {
    if ((await call('/v2/GetClusterStatus')).status === 200) break;
  } catch {}
  if (i > 60) throw new Error('garage admin API not reachable');
  await new Promise((r) => setTimeout(r, 1000));
}
const layout = (await call('/v2/GetClusterLayout')).json;
if (layout.roles.length === 0) {
  const status = (await call('/v2/GetClusterStatus')).json;
  await call('/v2/UpdateClusterLayout', { roles: [{ id: status.nodes[0].id, zone: 'dc1', capacity: 10_000_000_000, tags: [] }] });
  const applied = await call('/v2/ApplyClusterLayout', { version: layout.version + 1 });
  if (applied.status !== 200) throw new Error(`layout: ${applied.text}`);
}
const key = await call('/v2/ImportKey', { accessKeyId, secretAccessKey, name: 'crush' });
if (key.status !== 200 && !/exists/i.test(key.text)) throw new Error(`key: ${key.text}`);
let info = await call(`/v2/GetBucketInfo?globalAlias=${bucket}`);
if (info.status !== 200) {
  for (let i = 0; i < 20; i++) {
    info = await call('/v2/CreateBucket', { globalAlias: bucket });
    if (info.status === 200) break;
    await new Promise((r) => setTimeout(r, 500)); // layout may still be settling
  }
  if (info.status !== 200) throw new Error(`bucket: ${info.text}`);
}
const allow = await call('/v2/AllowBucketKey', { bucketId: info.json.id, accessKeyId, permissions: { read: true, write: true, owner: true } });
if (allow.status !== 200) throw new Error(`allow: ${allow.text}`);
console.log(`garage ready: bucket=${bucket} key=${accessKeyId}`);
