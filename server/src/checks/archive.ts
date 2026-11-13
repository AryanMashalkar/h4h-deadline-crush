import yauzl from 'yauzl';

/**
 * Inspects a zip using only its central directory, so a zip bomb is never
 * inflated. Limits are deliberately far above what an honest project needs.
 */
export const ZIP_LIMITS = {
  maxEntries: 10_000,
  maxTotalUncompressed: 1024 * 1024 * 1024, // 1 GiB
  maxRatio: 100, // per entry, for entries over 1 MiB
  maxReadmeBytes: 64 * 1024,
};

export interface ZipReport {
  ok: boolean;
  reason?: string;
  entries: number;
  totalUncompressed: number;
  maxRatio: number;
  nestedArchives: number;
  readme?: { path: string; text: string; truncated: boolean };
}

const README = /(^|\/)readme(\.(md|markdown|txt|rst))?$/i;
const ARCHIVE = /\.(zip|jar|gz|tgz|bz2|xz|7z|rar|tar)$/i;

function unsafePath(name: string): boolean {
  return name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..');
}

export function inspectZip(path: string, limits = ZIP_LIMITS): Promise<ZipReport> {
  return new Promise((resolve) => {
    const report: ZipReport = { ok: true, entries: 0, totalUncompressed: 0, maxRatio: 0, nestedArchives: 0 };
    let readme: { entry: yauzl.Entry; depth: number } | undefined;
    const done = (r: Partial<ZipReport>) => resolve({ ...report, ...r });

    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return done({ ok: false, reason: `not a readable zip archive (${err?.message ?? 'unknown'})` });
      const stop = (reason: string) => {
        zip.close();
        done({ ok: false, reason });
      };
      if (zip.entryCount > limits.maxEntries) return stop(`too many entries (${zip.entryCount} > ${limits.maxEntries})`);
      zip.on('error', (e: Error) =>
        // yauzl itself refuses "../" and absolute names; report those as what they are.
        stop(/relative path|absolute path|invalid characters/.test(e.message) ? `unsafe path in archive (${e.message})` : `corrupt archive (${e.message})`),
      );
      zip.on('entry', (entry: yauzl.Entry) => {
        report.entries++;
        if (unsafePath(entry.fileName)) return stop(`unsafe path in archive: ${entry.fileName}`);
        report.totalUncompressed += entry.uncompressedSize;
        if (report.totalUncompressed > limits.maxTotalUncompressed) {
          return stop(`expands to more than ${limits.maxTotalUncompressed / 1024 ** 3} GiB: likely a zip bomb`);
        }
        const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
        if (entry.uncompressedSize > 1024 * 1024) report.maxRatio = Math.max(report.maxRatio, Math.round(ratio));
        if (entry.uncompressedSize > 1024 * 1024 && ratio > limits.maxRatio) {
          return stop(`entry ${entry.fileName} compresses ${Math.round(ratio)}:1: likely a zip bomb`);
        }
        if (ARCHIVE.test(entry.fileName)) report.nestedArchives++;
        const isDir = entry.fileName.endsWith('/');
        if (!isDir && README.test(entry.fileName)) {
          const depth = entry.fileName.split('/').length;
          if (!readme || depth < readme.depth) readme = { entry, depth };
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!readme) {
          zip.close();
          return done({});
        }
        const entry = readme.entry;
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            zip.close();
            return done({});
          }
          // Read at most maxReadmeBytes of inflated data, then stop inflating.
          const chunks: Buffer[] = [];
          let got = 0;
          let finished = false;
          const finish = (truncated: boolean) => {
            if (finished) return;
            finished = true;
            stream.destroy();
            zip.close();
            done({ readme: { path: entry.fileName, text: Buffer.concat(chunks).toString('utf8').replace(/\u0000/g, ''), truncated } });
          };
          stream.on('data', (c: Buffer) => {
            const room = limits.maxReadmeBytes - got;
            chunks.push(c.subarray(0, room));
            got += Math.min(c.length, room);
            if (got >= limits.maxReadmeBytes) finish(true);
          });
          stream.on('end', () => finish(false));
          stream.on('error', () => finish(true));
        });
      });
      zip.readEntry();
    });
  });
}
