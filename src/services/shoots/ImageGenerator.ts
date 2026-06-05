import { base64ToArrayBuffer } from '../../lib/r2'
import { getDb } from '../../db'
import { privateAssets } from '../../db/schema'
import { ShootPrompt, ShootPackage, GeneratedShot } from '../../types/shoots'

interface ImageGenEnv {
  OPENAI_API_KEY: string
  ASSETS_BUCKET: any
  DATABASE_URL: string
}

export class ImageGenerator {
  constructor(private env: ImageGenEnv) {}

  async generate(
    shootPrompt: ShootPrompt,
    pkg: ShootPackage,
    userId: string,
    projectId: string
  ): Promise<GeneratedShot> {
    // Build multipart form — Workers native FormData + fetch, no SDK needed
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', shootPrompt.prompt)
    form.append('size', '1024x1536')  // portrait, closest to 9:16
    form.append('n', '1')

    // Attach reference product image
    const imageBytes = Uint8Array.from(atob(pkg.asset.base64), c => c.charCodeAt(0))
    const imageBlob = new Blob([imageBytes], { type: pkg.asset.mimeType || 'image/jpeg' })
    form.append('image[]', imageBlob, 'product.jpg')

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
      body: form,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenAI image edit failed (${res.status}): ${err}`)
    }

    const json: any = await res.json()
    const b64 = json?.data?.[0]?.b64_json
    if (!b64) throw new Error(`ImageGenerator: no image in OpenAI response for shoot ${shootPrompt.shootIndex}`)

    // Store to R2
    const r2Key = `photoshoots/${userId}/${projectId}/${Date.now()}-shot${shootPrompt.shootIndex}.jpg`
    await this.env.ASSETS_BUCKET.put(
      r2Key,
      base64ToArrayBuffer(b64),
      { httpMetadata: { contentType: 'image/png' } }
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
