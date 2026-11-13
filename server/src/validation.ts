import { z } from 'zod';

export const uuid = z.string().uuid();
export const clientKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'clientKey must be 8-100 letters, digits, - or _');

const link = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Links must start with http:// or https://');

export const details = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).default(''),
  links: z.array(link).max(10).default([]),
});

export const startUpload = details.extend({
  clientKey,
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((n) => !/[\\/\u0000-\u001f]/.test(n), 'File name cannot contain slashes or control characters'),
  contentType: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
});

export const saveDetails = details.extend({ clientKey });

export const signParts = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
});

export const completeUpload = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10000),
});

export const login = z.object({ email: z.string().trim().email().max(200), password: z.string().min(8).max(200) });

export const updateHackathon = z.object({
  deadline: z.string().datetime({ offset: true }).optional(),
  graceSeconds: z.number().int().min(0).max(3600).optional(),
});

export const demo = z.object({
  minutes: z.number().int().min(1).max(120).default(5),
  graceSeconds: z.number().int().min(0).max(900).default(120),
});
