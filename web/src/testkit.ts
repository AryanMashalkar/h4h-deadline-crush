/**
 * Judge test kit: sample files built in the browser (or fetched from /test-kit/)
 * so anyone can try the edge cases on the live site in one click. They go
 * through exactly the same upload pipeline and server checks as a real file.
 */

const MiB = 1024 * 1024;

/** A real one-page PDF, padded to ~45 MB so the upload uses 5 parts of 10 MiB. */
export function samplePdf(): File {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // content stream, below
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>',
  ];
  const text = [
    'BT /F1 34 Tf 60 720 Td (Deadline Crush) Tj ET',
    'BT /F1 16 Tf 60 680 Td (Sample submission from the judge test kit) Tj ET',
    'BT /F1 12 Tf 60 640 Td (45 MB, uploaded in 10 MiB parts straight to object storage.) Tj ET',
  ].join('\n');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o ?? `<</Length ${text.length}>>\nstream\n${text}\nendstream`}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  // Padding after %%EOF is ignored by PDF readers; it only makes the file big enough to show multipart.
  const pad = new Uint8Array(45 * MiB - body.length).fill(0x20);
  return new File([body, pad], 'sample-submission.pdf', { type: 'application/pdf' });
}

/** A text file wearing a .pdf name: the server types files by content, not by name. */
export function disguisedPdf(): File {
  const text = 'MZ This is not a PDF. It is a renamed program stub; the name says .pdf, the bytes do not.\n'.repeat(40);
  return new File([text], 'definitely-a-report.pdf', { type: 'application/pdf' });
}

/**
 * A real PDF carrying the EICAR antivirus test signature (harmless by design,
 * used to test scanners). Assembled here so the site's bundle is not flagged.
 */
export function eicarPdf(): File {
  const sig = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
  const body = `%PDF-1.4\n% Deadline Crush test kit: antivirus test file\n${sig}\n%%EOF\n`;
  return new File([body], 'eicar-test.pdf', { type: 'application/pdf' });
}

/** A 300 KB ZIP whose entry claims 300 MB (ratio ~1029:1). Never extracted by the server. */
export async function zipBomb(): Promise<File> {
  const res = await fetch('/test-kit/zip-bomb.zip');
  if (!res.ok) throw new Error('could not load the sample zip bomb');
  return new File([await res.blob()], 'zip-bomb.zip', { type: 'application/zip' });
}
