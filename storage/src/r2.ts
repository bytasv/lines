/**
 * Cloudflare R2 upload for recipe screenshots.
 *
 * The bucket is public-read (r2.dev subdomain or a custom domain), so the app
 * never signs GETs and `RecipeDef.images` holds plain URLs a browser `<img>` can
 * load with no token plumbing. Uploads arrive here as base64 over the bridge —
 * presigned direct-from-browser PUTs were rejected because `web` never learns
 * `STORAGE_URL`, this server has no CORS middleware, and it would mean
 * browser-held bearer tokens plus out-of-repo bucket CORS.
 *
 * Recipes must work without images, so nothing here is a boot requirement:
 * unconfigured R2 is one warning and a 503 on the upload route.
 */
import { randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** True when every R2 env var needed to upload and serve is present. */
export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET &&
      process.env.R2_PUBLIC_BASE_URL,
  );
}

/**
 * Why `R2_PUBLIC_BASE_URL` cannot serve the images it is pointed at, or null.
 *
 * The failure this catches is silent and expensive to debug: the S3 API endpoint
 * (`https://<account>.r2.cloudflarestorage.com`) is what every R2 credentials
 * page shows, so it is the obvious thing to paste here — but a browser `<img>`
 * fetch against it is unsigned, so uploads "succeed", the URL is stored in an
 * immutable recipe version, and the only symptom is a broken image with nothing
 * in the console. The public base has to be the bucket's r2.dev subdomain or a
 * custom domain, with public access enabled on the bucket.
 */
export function r2PublicBaseWarning(): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (!base) return null;
  if (!/^https?:\/\//.test(base)) return 'R2_PUBLIC_BASE_URL must be an absolute http(s) URL';
  if (/\.r2\.cloudflarestorage\.com/.test(base)) {
    return 'R2_PUBLIC_BASE_URL points at the S3 API endpoint — browsers cannot load images from it. Use the bucket\'s public r2.dev subdomain or a custom domain';
  }
  return null;
}

/** Built on first upload, not at boot — an install with no R2 never loads the SDK. */
let clientPromise: Promise<S3Client> | null = null;

function client(): Promise<S3Client> {
  clientPromise ??= import('@aws-sdk/client-s3').then(
    ({ S3Client }) =>
      new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      }),
  );
  return clientPromise;
}

/**
 * Store one image and return its public URL. Keyed by owner so a bucket listing
 * stays navigable; the uuid means a re-upload never overwrites an older
 * version's image (immutable versions keep rendering their own set).
 */
export async function putRecipeImage(userId: string, mediaType: string, body: Buffer): Promise<string> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const key = `recipes/${userId}/${randomUUID()}.${EXT[mediaType] ?? 'bin'}`;
  const s3 = await client();
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: body,
      ContentType: mediaType,
    }),
  );
  return `${process.env.R2_PUBLIC_BASE_URL!.replace(/\/+$/, '')}/${key}`;
}
