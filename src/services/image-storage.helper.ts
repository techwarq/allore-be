import { PinterestService } from "./pinterest.service";

/**
 * Interface for image data to be stored.
 */
export interface GeminiImageData {
  mimeType: string;
  data: string; // Base64
}

/**
 * Interface for storage results.
 */
export interface StoredAsset {
  id: string;
  fileUrl: string;
  signedUrl: string;
}

/**
 * Converts a list of Gemini-generated images (base64) into persistent storage (R2).
 * Then saves references in the private_assets table.
 */
export async function convertGeminiImagesToStorage(
  images: GeminiImageData[],
  options: {
    filenamePrefix: string;
    userId: string;
    projectId?: string;
    chatId?: string;
    metadata?: any;
    db?: any;     // Database instance from Cloudflare Bindings
    bucket?: any; // R2 Bucket from Cloudflare Bindings
  }
): Promise<StoredAsset[]> {
  const results: StoredAsset[] = [];

  // Note: Since this is often called inside a worker or background script,
  // we expect db and bucket to be passed in options.
  const { db, bucket, userId, filenamePrefix, metadata } = options;

  if (!db || !bucket) {
    console.warn("⚠️ Database or Bucket not provided to image-storage helper. Returning base64 fallback.");
    return images.map((img, i) => ({
      id: `fallback-${i}`,
      fileUrl: `data:${img.mimeType};base64,${img.data}`,
      signedUrl: `data:${img.mimeType};base64,${img.data}`,
    }));
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      // Convert base64 to ArrayBuffer
      const binaryString = atob(img.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let j = 0; j < binaryString.length; j++) {
        bytes[j] = binaryString.charCodeAt(j);
      }

      // Reuse PinterestService.saveToR2 for consistency
      const asset = await PinterestService.saveToR2(
        db,
        bucket,
        userId,
        `${filenamePrefix}-${i}`,
        { ...metadata, source: 'gemini-engine' },
        bytes.buffer,
        img.mimeType,
        options.projectId,
        options.chatId
      );

      results.push({
        id: asset.id,
        fileUrl: asset.url,
        signedUrl: asset.url,
      });
    } catch (error) {
      console.error(`❌ Failed to store Gemini image ${i}:`, error);
    }
  }

  return results;
}
