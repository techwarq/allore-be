import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import { privateAssets } from '../db/schema';
import { TextService } from './gemini/TextService';
import { AssetSearchService } from './assetSearch.service';

export interface BulkIngestResult {
  url: string;
  success: boolean;
  assetId?: string;
  error?: string;
}

export class BulkIngestService {
  private db: NeonHttpDatabase<any>;
  private textService: TextService;
  private assetSearchService: AssetSearchService;
  private bucket: R2Bucket;

  constructor(env: any, db: NeonHttpDatabase<any>) {
    this.db = db;
    this.bucket = env.ASSETS_BUCKET;
    this.textService = new TextService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
    this.assetSearchService = new AssetSearchService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.QDRANT_URL,
      env.QDRANT_API_KEY,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );
  }

  /**
   * Processes a batch of image URLs sequentially to avoid rate limits.
   * Directly ingests into Qdrant for the global Pinterest DB.
   */
  async processBatch(urls: string[], contextTags: string = ""): Promise<BulkIngestResult[]> {
    const results: BulkIngestResult[] = [];

    for (const url of urls) {
      try {
        // Sleep for 2 seconds to avoid Vertex Quota Limits
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 1. Fetch the image from the URL
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch image. Status: ${imageResponse.status}`);
        }

        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
        const buffer = await imageResponse.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString('base64');

        // 1.5 Save to Cloudflare R2 permanently
        const fileExt = contentType.split('/')[1] || 'jpg';
        const r2Key = `pinterest_db/${Date.now()}-${crypto.randomUUID()}.${fileExt}`;
        
        await this.bucket.put(r2Key, buffer, {
          httpMetadata: { contentType }
        });

        // The permanent URL to be saved in Qdrant
        const permanentUrl = r2Key;

        // 2. Extract Metadata via Gemini Vision
        const contextStr = contextTags
          ? `\nContext / User Search Tags used to find this image: "${contextTags}"\nUse these tags to help categorize and name the image better.`
          : "";

        const prompt = `
Analyze this image. Give it a descriptive name and extract the following metadata.${contextStr}

Return ONLY a valid JSON object matching this structure:
{
  "name": "string", // A short, descriptive title (e.g., "Dark Minimalist Watch Scene")
  "tags": ["string", "string"], // Descriptive visual tags
  "colors": ["#HexCode", "#HexCode"], // Dominant hex colors
  "angle": "string", // e.g., "top-down", "eye-level", "close-up", "wide"
  "background": "string", // e.g., "solid white", "outdoor city", "studio"
  "description": "string" // A 1-2 sentence detailed visual description
}
        `.trim();

        const responseText = await this.textService.generateText({
          model: "gemini-3-flash-preview",
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: contentType,
                    data: base64Data
                  }
                }
              ]
            }
          ]
        });

        const jsonStr = responseText.replace(/^```json/m, '').replace(/```$/m, '').trim();
        const aiData = JSON.parse(jsonStr);

        const name = aiData.name || 'Untitled Asset';
        const tags = Array.isArray(aiData.tags) ? aiData.tags : [];
        const colors = Array.isArray(aiData.colors) ? aiData.colors : [];
        const angle = typeof aiData.angle === 'string' ? aiData.angle : null;
        const background = typeof aiData.background === 'string' ? aiData.background : null;
        const parsedData = {
          description: aiData.description,
          name: name
        };

        // 3. Save to Postgres (Drizzle) into privateAssets table
        const [insertedAsset] = await this.db.insert(privateAssets).values({
          r2Key,
          tags: sql`${JSON.stringify(tags)}::jsonb`,
          colors: sql`${JSON.stringify(colors)}::jsonb`,
          angle,
          background,
          parsedData: sql`${JSON.stringify(parsedData)}::jsonb`
        } as any).returning();

        // 4. Save to Qdrant Vector DB mapping to the Postgres ID
        const descriptionForVector = `
Name: ${name}
Description: ${parsedData.description || 'Uploaded asset'}
Tags: ${tags.join(', ')}
Colors: ${colors.join(', ')}
Angle: ${angle || 'unknown'}
Background: ${background || 'unknown'}
        `.trim();

        await this.assetSearchService.ingestPinterestAsset(
          insertedAsset.id,
          descriptionForVector,
          tags
        );

        results.push({ url: permanentUrl, success: true, assetId: insertedAsset.id });
        console.log(`[BulkIngest] Successfully processed: ${url}`);

      } catch (err: any) {
        console.error(`[BulkIngest] Failed processing URL ${url}:`, err);
        results.push({ url, success: false, error: err.message });
      }
    }

    return results;
  }
}
