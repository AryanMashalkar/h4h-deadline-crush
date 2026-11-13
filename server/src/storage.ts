import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { config } from './config.js';

/**
 * Object storage. The API only ever signs URLs and calls metadata operations
 * (create, list parts, complete, head): file bytes go browser -> bucket directly.
 */
export class Storage {
  readonly client: S3Client;
  /** Same credentials, but signs URLs for the host the browser can reach. */
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(cfg = config.s3) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // R2 and Garage reject the newer default CRC32 checksum headers on presigned parts.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.signer = new S3Client({ ...base, endpoint: cfg.publicEndpoint });
    this.bucket = cfg.bucket;
  }

  async configureCors(allowedOrigins: string[]) {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: allowedOrigins,
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['*'],
              // Without ETag exposed the browser cannot report part ETags.
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error('storage returned no UploadId');
    return res.UploadId;
  }

  signPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string> {
    return getSignedUrl(this.signer, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), {
      expiresIn,
    });
  }

  async listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]> {
    const out: { partNumber: number; etag: string; size: number }[] = [];
    let marker: string | undefined;
    for (;;) {
      const res = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of res.Parts ?? []) out.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size ?? 0 });
      if (!res.IsTruncated) return out;
      marker = res.NextPartNumberMarker;
    }
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string) {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => {});
  }

  /** Size of a stored object, or null if it does not exist. */
  async head(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? 0;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async put(key: string, body: Buffer | string, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  signDownload(key: string, fileName: string, expiresIn: number): Promise<string> {
    const safe = fileName.replace(/[^\w.\- ]/g, '_');
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safe}"` }),
      { expiresIn },
    );
  }
}
