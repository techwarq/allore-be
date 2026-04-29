import { R2Bucket } from "@cloudflare/workers-types";

/**
 * Generates a signed URL for an R2 object.
 * Note: createSignedUrl is available on the R2Bucket object in Cloudflare Workers.
 */
export async function getSignedR2Url(bucket: R2Bucket, key: string, expiresIn = 3600): Promise<string> {
  // @ts-ignore - createSignedUrl might not be in all type definitions but exists in runtime
  const url = await bucket.createSignedUrl(key, { expiresIn });
  return url;
}

/**
 * Fetches an R2 object and returns its content as base64.
 */
export async function fetchR2AsBase64(
  bucket: R2Bucket,
  key: string
): Promise<{ data: string; mimeType: string }> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`R2 object not found: ${key}`);
  
  const buffer = await obj.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  
  const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
  return { data: btoa(binary), mimeType };
}

/**
 * Converts a base64 string back to an ArrayBuffer for R2 storage.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
