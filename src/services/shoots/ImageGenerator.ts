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
    projectId: string,
    modelBytes?: { data: string; mimeType: string } | null
  ): Promise<GeneratedShot> {
    const productBytes = Uint8Array.from(atob(pkg.asset.base64), c => c.charCodeAt(0))
    const productBlob  = new Blob([productBytes], { type: pkg.asset.mimeType || 'image/jpeg' })

    const modelBlob = modelBytes
      ? new Blob([Uint8Array.from(atob(modelBytes.data), c => c.charCodeAt(0))], { type: modelBytes.mimeType || 'image/jpeg' })
      : null

    // When a model reference is provided, extend the prompt so OpenAI knows what to do with it
    const finalPrompt = modelBlob
      ? `${shootPrompt.prompt}\n\nA model reference image is provided alongside the product. The human in this shoot must resemble that person — same face, build, and appearance. They must be wearing the product.`
      : shootPrompt.prompt

    const buildForm = () => {
      const f = new FormData()
      f.append('model', 'gpt-image-2')
      f.append('prompt', finalPrompt)
      f.append('size', '1024x1536')
      f.append('n', '1')
      f.append('image[]', productBlob, 'product.jpg')
      if (modelBlob) f.append('image[]', modelBlob, 'model.jpg')
      return f
    }

    let res: Response | null = null
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
        body: buildForm(),
      })
      if (res.ok) break
      lastError = await res.text()
      console.warn(`[ImageGenerator] Attempt ${attempt} failed (${res.status}): ${lastError}`)
      if (res.status !== 503 && res.status !== 429) break
      await new Promise(r => setTimeout(r, attempt * 3000))
    }

    if (!res!.ok) {
      throw new Error(`OpenAI image edit failed (${res!.status}): ${lastError}`)
    }

    const json: any = await res!.json()
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
