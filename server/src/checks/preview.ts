import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Renders page 1 of a PDF to PNG with poppler's pdftoppm, in a child process
 * with a time limit, so a hostile PDF can hang or crash only that process.
 * Returns null when pdftoppm is missing or fails: a preview is a convenience,
 * not a pass/fail check.
 */
export function renderPdfFirstPage(pdfPath: string, workDir: string, timeoutMs = 20_000): Promise<Buffer | null> {
  const outBase = path.join(workDir, 'preview');
  return new Promise((resolve) => {
    execFile(
      'pdftoppm',
      ['-png', '-f', '1', '-l', '1', '-singlefile', '-scale-to', '800', pdfPath, outBase],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      async (err) => {
        if (err) return resolve(null);
        try {
          const png = await readFile(`${outBase}.png`);
          await rm(`${outBase}.png`, { force: true });
          resolve(png);
        } catch {
          resolve(null);
        }
      },
    );
  });
}
