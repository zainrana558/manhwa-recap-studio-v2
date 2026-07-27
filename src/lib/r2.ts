/**
 * r2.ts — read-side Cloudflare R2 helper for the Next.js app.
 *
 * The pipeline-service uploads finished videos to R2 and deletes the local
 * copy once uploaded (see mini-services/pipeline-service/r2.ts + index.ts).
 * This module lets the download route generate a URL to hand the browser
 * when the local file no longer exists but job.r2Key does.
 *
 * Same env vars as the pipeline-service:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_PUBLIC_URL (optional — public bucket/custom domain)
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET
  );
}

function getClient(): S3Client {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 is not configured (missing R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

/**
 * Get a URL the browser can stream/download a video from directly (Range
 * requests work either way, so in-browser seeking still works).
 */
export async function getR2Url(key: string, expiresInSeconds = 3600): Promise<string> {
  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase) {
    return `${publicBase.replace(/\/+$/, "")}/${key}`;
  }
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET is not set");
  const s3 = getClient();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}
