import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectZip } from '../src/checks/archive.js';
import { checkLink, isPublicAddress } from '../src/checks/links.js';
import { Worker } from '../src/worker/worker.js';
import { api, fixture, startHarness, tinyPdf, uploadFile, waitForJobs, type Harness } from './helpers.js';
import { makeZip } from './zip.js';

let dir: string;
const write = async (name: string, b: Buffer) => {
  const p = path.join(dir, name);
  await writeFile(p, b);
  return p;
};

let site: Server;
let siteUrl: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'checks-'));
  site = createServer((req, res) => {
    if (req.url === '/ok') return res.end('fine');
    if (req.url === '/no-head') return res.writeHead(req.method === 'HEAD' ? 405 : 200).end('ok');
    if (req.url === '/redirect') return res.writeHead(302, { location: '/ok' }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 3000);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => site.close());

describe('zip inspection', () => {
  it('accepts a normal project and previews its top-level README', async () => {
    const z = await inspectZip(
      await write('ok.zip', makeZip([
        { name: 'src/index.js', data: Buffer.from('console.log(1)') },
        { name: 'docs/README.md', data: Buffer.from('nested readme') },
        { name: 'README.md', data: Buffer.from('# Hello judges') },
      ])),
    );
    expect(z.ok).toBe(true);
    expect(z.readme?.text).toBe('# Hello judges');
  });

  it('rejects a high-ratio entry (zip bomb) without inflating it', async () => {
    const z = await inspectZip(await write('bomb.zip', makeZip([{ name: 'zeros.bin', data: Buffer.alloc(50 * 1024 * 1024) }])));
    expect(z.ok).toBe(false);
    expect(z.reason).toMatch(/zip bomb/);
  });

  it('rejects archives whose headers claim more than 1 GiB in total', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x'), claimedSize: 500 * 1024 * 1024 }));
    const z = await inspectZip(await write('big.zip', makeZip(entries)), { maxEntries: 100, maxTotalUncompressed: 1024 ** 3, maxRatio: 1e12, maxReadmeBytes: 1000 });
    expect(z.ok).toBe(false);
    expect(z.reason).toMatch(/GiB/);
  });

  it('rejects path traversal (zip slip) and too many entries', async () => {
    const slip = await inspectZip(await write('slip.zip', makeZip([{ name: '../../etc/cron.d/x', data: Buffer.from('boom') }])));
    expect(slip.ok).toBe(false);
    expect(slip.reason).toMatch(/unsafe path/);
    const many = await inspectZip(
      await write('many.zip', makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })))),
      { maxEntries: 5, maxTotalUncompressed: 1e9, maxRatio: 100, maxReadmeBytes: 1000 },
    );
    expect(many.ok).toBe(false);
    expect(many.reason).toMatch(/too many entries/);
  });

  it('reports a corrupt archive instead of crashing', async () => {
    const z = await inspectZip(await write('bad.zip', Buffer.from('PK\u0003\u0004 definitely not a zip')));
    expect(z.ok).toBe(false);
  });
});

describe('link checks and SSRF protection', () => {
  it('classifies addresses: only public unicast is allowed', () => {
    for (const a of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses private targets by IP literal, by DNS name, by port and by scheme', async () => {
    const strict = { timeoutMs: 2000, allowPrivate: false };
    expect((await checkLink('http://169.254.169.254/latest/meta-data/', strict)).error).toMatch(/not public/);
    expect((await checkLink(`http://localhost:80/`, strict)).error).toMatch(/non-public address/);
    expect((await checkLink('http://[::ffff:7f00:1]/', strict)).error).toMatch(/not public/);
    expect((await checkLink('http://example.com:6379/', strict)).error).toMatch(/port 6379/);
    expect((await checkLink('ftp://example.com/', strict)).error).toMatch(/scheme/);
    expect((await checkLink('http://user:pw@example.com/', strict)).error).toMatch(/credentials/);
  });

  it('follows redirects, falls back from HEAD to GET, and reports dead, looping and slow links', async () => {
    const o = { timeoutMs: 1000, allowPrivate: true };
    expect((await checkLink(`${siteUrl}/ok`, o)).ok).toBe(true);
    expect((await checkLink(`${siteUrl}/no-head`, o)).ok).toBe(true);
    const r = await checkLink(`${siteUrl}/redirect`, o);
    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe(`${siteUrl}/ok`);
    expect((await checkLink(`${siteUrl}/missing`, o)).status).toBe(404);
    expect((await checkLink(`${siteUrl}/loop`, o)).error).toMatch(/redirects/);
    expect((await checkLink(`${siteUrl}/slow`, o)).error).toMatch(/timed out|abort/i);
  });
});

describe('background checks through the API', () => {
  let h: Harness;
  let worker: Worker;
  beforeAll(async () => {
    h = await startHarness();
    worker = new Worker({ pool: h.pool, storage: h.storage, concurrency: 2, pollMs: 50 });
    worker.start();
  });
  afterAll(async () => {
    await worker.stop();
    await h.close();
  });

  async function submit(file: Buffer, fileName: string, links: string[] = []) {
    const f = await fixture(h.pool);
    const call = api(h.baseUrl, f.token);
    const { complete } = await uploadFile(call, f.teamId, file, { fileName, links });
    expect(complete.status).toBe(201);
    await waitForJobs(h.pool);
    return (await call('GET', `/api/teams/${f.teamId}/submission`)).body.versions[0];
  }

  it('detects the type by content: a text file named .pdf needs a fix', async () => {
    const v = await submit(Buffer.from('just some text pretending to be a pdf'), 'project.pdf');
    expect(v.status).toBe('needs_fix');
    expect(v.checks.find((c: any) => c.name === 'file_type').ok).toBe(false);
  });

  it('a zip bomb needs a fix; a good zip is accepted with its README as preview', async () => {
    const bomb = await submit(makeZip([{ name: 'a.bin', data: Buffer.alloc(30 * 1024 * 1024) }]), 'project.zip');
    expect(bomb.status).toBe('needs_fix');
    expect(bomb.statusReason).toMatch(/zip bomb/);
    const good = await submit(makeZip([{ name: 'README.md', data: Buffer.from('# Our project') }, { name: 'a.js', data: Buffer.from('1') }]), 'project.zip');
    expect(good.status).toBe('accepted');
    expect(good.previewText).toBe('# Our project');
  });

  it('renders a first-page preview for PDFs', async () => {
    const v = await submit(tinyPdf(), 'deck.pdf');
    expect(v.status).toBe('accepted');
    expect(v.hasPreview).toBe(true);
  });

  it('a dead link needs a fix; a working one passes', async () => {
    const v = await submit(tinyPdf(), 'deck.pdf', [`${siteUrl}/ok`, `${siteUrl}/gone`]);
    expect(v.status).toBe('needs_fix');
    const links = v.checks.find((c: any) => c.name === 'links');
    expect(links.detail.links.map((l: any) => l.ok)).toEqual([true, false]);
  });
});
