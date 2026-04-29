import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { assets } from '../db/schema';
import { TextService } from './gemini/TextService';
import { AssetSearchService } from './assetSearch.service';

export interface UploadAssetParams {
  userId: string;
  projectId: string;
  file: File;
  type: string;        // 'image', 'video', 'document'
  subtype: string;     // 'product_image', 'lifestyle_image', 'logo', 'reference'
  productId?: string;
  chatId?: string;
}

export class AssetUploadService {
  private db: PostgresJsDatabase;
  private bucket: R2Bucket;
  private textService: TextService;
  private assetSearchService: AssetSearchService;

  constructor(env: any, db: PostgresJsDatabase) {
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

  async processUpload(params: UploadAssetParams) {
    // 1. Upload to R2 Bucket
    const fileExt = params.file.name.split('.').pop();
    const fileName = `brands/${params.userId}/assets/${Date.now()}-${crypto.randomUUID()}.${fileExt}`;

    await this.bucket.put(fileName, params.file.stream(), {
      httpMetadata: { contentType: params.file.type }
    });
    const url = fileName;

    // 2. Extract Metadata via Gemini Vision (if image)
    let tags: string[] = [];
    let colors: string[] = [];
    let angle = null;
    let background = null;
    let parsedData = {};

    if (params.file.type.startsWith('image/')) {
      try {
        const buffer = await params.file.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString('base64');

        const prompt = `
Analyze this image and extract the following metadata.
Return ONLY a valid JSON object matching this structure:
{
  "name": "string", // Short product name (e.g. "Black Oversized Hoodie", "Gold Serum Bottle", "White Sneaker"). Be specific and concise.
  "tags": ["string", "string"], // Descriptive visual tags
  "colors": ["#HexCode", "#HexCode"], // Dominant hex colors
  "angle": "string", // e.g., "top-down", "eye-level", "close-up", "wide"
  "background": "string", // e.g., "solid white", "outdoor city", "studio"
  "description": "string" // A 1-2 sentence detailed visual description
}
        `.trim();

        const responseText = await this.textService.generateText({
          model: "gemini-3-flash-preview", // 1.5 Pro is excellent at vision
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: params.file.type,
                    data: base64Data
                  }
                }
              ]
            }
          ]
        });

        const jsonStr = responseText.replace(/^```json/m, '').replace(/```$/m, '').trim();
        const aiData = JSON.parse(jsonStr);

        tags = aiData.tags || [];
        colors = aiData.colors || [];
        angle = aiData.angle || null;
        background = aiData.background || null;
        parsedData = {
          name: aiData.name || null,
          description: aiData.description || null,
        };

      } catch (err) {
        console.error("[AssetUploadService] Failed to extract AI metadata:", err);
        // We continue even if AI fails, just without rich metadata
      }
    }

    // 3. Save to Postgres (Drizzle)
    const [insertedAsset] = await this.db.insert(assets).values({
      userId: params.userId,
      projectId: params.projectId,
      chatId: params.chatId || null,
      productId: params.productId || null,
      type: params.type,
      subtype: params.subtype,
      source: 'upload',
      url,
      tags,
      colors,
      angle,
      background,
      parsedData
    }).returning();

    // 4. Save to Qdrant Vector DB
    // We combine the extracted text into a rich description for the embedding model
    const descriptionForVector = `
Type: ${params.subtype}
Description: ${(parsedData as any).description || 'Uploaded asset'}
Tags: ${tags.join(', ')}
Colors: ${colors.join(', ')}
Angle: ${angle || 'unknown'}
Background: ${background || 'unknown'}
    `.trim();

    try {
      await this.assetSearchService.ingest(descriptionForVector, {
        assetId: insertedAsset.id,
        userId: params.userId,
        projectId: params.projectId,
        type: params.type,
        tags
      });
    } catch (err) {
      console.error("[AssetUploadService] Failed to ingest into Qdrant:", err);
      // We don't fail the upload if Qdrant fails, as Postgres is the source of truth
    }

    return insertedAsset;
  }
}
