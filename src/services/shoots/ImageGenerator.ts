import { TextService } from '../gemini/TextService'
import { base64ToArrayBuffer } from '../../lib/r2'
import { getDb } from '../../db'
import { privateAssets } from '../../db/schema'
import { ShootPrompt, ShootPackage, GeneratedShot } from '../../types/shoots'

interface ImageGenEnv {
  ASSETS_BUCKET: any   // R2Bucket — typed as any to avoid @cloudflare/workers-types version conflict
  DATABASE_URL: string
}

export class ImageGenerator {
  constructor(
    private textService: TextService,
    private env: ImageGenEnv
  ) {}

  async generate(
    shootPrompt: ShootPrompt,
    pkg: ShootPackage,
    userId: string,
    projectId: string
  ): Promise<GeneratedShot> {
    const spec = pkg.asset.productSpec

    const parts: any[] = [
      // Reference product image always goes first
      {
        inlineData: {
          mimeType: pkg.asset.mimeType,
          data: pkg.asset.base64
        }
      },
      {
        text: `PRODUCT REFERENCE IMAGE: The image above is the exact product to photograph. Reproduce it with zero modifications — same materials, color, finish, shape, and all visible details.

${shootPrompt.prompt}

FIDELITY REMINDER: The reference product is a ${spec.productType} in ${spec.colorProfile.primary}, ${spec.finish} finish. Spatial anchor: ${spec.spatialAnchor}. Every detail listed above must appear in the output exactly as described.`
      }
    ]

    const response = await this.textService.generate({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '9:16', imageSize: '2K' }
      }
    })

    const imagePart = response?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)
    if (!imagePart?.inlineData?.data) {
      throw new Error(`ImageGenerator: no image returned for shoot ${shootPrompt.shootIndex}`)
    }

    // Store to R2
    const r2Key = `photoshoots/${userId}/${projectId}/${Date.now()}-shot${shootPrompt.shootIndex}.jpg`
    await this.env.ASSETS_BUCKET.put(
      r2Key,
      base64ToArrayBuffer(imagePart.inlineData.data),
      { httpMetadata: { contentType: imagePart.inlineData.mimeType || 'image/jpeg' } }
    )

    // Save asset record
    const assetId = crypto.randomUUID()
    const db = getDb(this.env.DATABASE_URL)
    await db.insert(privateAssets).values({
      id: assetId,
      userId,
      projectId: projectId === 'default' ? null : projectId,
      r2Key,
      type: 'photoshoot',
      metadata: {
        shootIndex: shootPrompt.shootIndex,
        concept: shootPrompt.concept,
        theme: pkg.theme,
        angle: pkg.angle,
        prompt: shootPrompt.prompt,
        sourceAssetId: pkg.asset.id,
      }
    })

    return {
      shootIndex: shootPrompt.shootIndex,
      r2Key,
      assetId,
      concept: shootPrompt.concept,
      theme: pkg.theme,
      url: `/assets/private/${encodeURIComponent(r2Key)}`,
    }
  }
}
