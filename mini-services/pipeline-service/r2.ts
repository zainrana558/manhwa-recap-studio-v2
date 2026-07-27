/**
 * r2.ts — Cloudflare R2 storage helper.
 *
 * R2 is S3-compatible, so we use the standard AWS SDK v3 S3 client pointed
 * at R2's endpoint. Used to offload finished recap videos off local disk
 * once a job completes, since a 200-chapter job's local temp files (raw
 * scraped images, sliced frames, per-panel audio, per-chapter renders) add
 * up fast and are never needed again after the final video exists.
 *
 * Required env vars (set these in your .env / deployment secrets):
 *   R2_ACCOUNT_ID          — Cloudflare account id
 *   R2_ACCESS_KEY_ID       — R2 API token access key id
 *   R2_SECRET_ACCESS_KEY   — R2 API token secret
 *   R2_BUCKET              — bucket name to upload into
 * Optional:
 *   R2_PUBLIC_URL          — base URL if the bucket has a public custom
 *                            domain/dev URL (e.g. https://cdn.example.com or
 *                            https://pub-xxxx.r2.dev). If set, uploaded
 *                            files are served directly from this URL
 *                            instead of via presigned URLs.
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createReadStream, promises as fs } from 'fs'

let client: S3Client | null = null

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  )
}

function getClient(): S3Client {
  if (client) return client
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 is not configured (missing R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)')
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return client
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET
  if (!bucket) throw new Error('R2_BUCKET is not set')
  return bucket
}

/**
 * Upload a local file to R2 under `key`. Streams the file rather than
 * loading it into memory, since final recap videos can be large.
 * Verifies the object landed (HeadObject) before returning, so callers can
 * safely delete the local copy right after a successful call.
 */
export async function uploadFileToR2(
  localPath: string,
  key: string,
  contentType = 'video/mp4',
): Promise<void> {
  const s3 = getClient()
  const bucket = getBucket()
  const stat = await fs.stat(localPath)

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: contentType,
      ContentLength: stat.size,
    }),
  )

  // Confirm the object actually exists in the bucket before the caller
  // trusts it enough to delete the local file.
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
}

/** Delete an object from R2 (used if you want to clean up on job deletion). */
export async function deleteFromR2(key: string): Promise<void> {
  const s3 = getClient()
  await s3.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }))
}

/**
 * Get a URL the browser can stream/download the video from directly.
 * If R2_PUBLIC_URL is set (public bucket / custom domain), returns a plain
 * public URL. Otherwise generates a time-limited presigned URL — either way
 * R2 serves Range requests natively, so in-browser video seeking still works.
 */
export async function getR2Url(key: string, expiresInSeconds = 3600): Promise<string> {
  const publicBase = process.env.R2_PUBLIC_URL
  if (publicBase) {
    return `${publicBase.replace(/\/+$/, '')}/${key}`
  }
  const s3 = getClient()
  const cmd = new GetObjectCommand({ Bucket: getBucket(), Key: key })
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds })
}
