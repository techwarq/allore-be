import { base64ToArrayBuffer } from '../../lib/r2'
import { getDb } from '../../db'
import { privateAssets } from '../../db/schema'
import { ShootPrompt, ShootPackage, GeneratedShot, AssetWithSpec } from '../../types/shoots'

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
    allAssets: AssetWithSpec[],
    userId: string,
    projectId: string,
    modelBytes?: { data: string; mimeType: string } | null,
  ): Promise<GeneratedShot> {
    const modelBlob = modelBytes
      ? new Blob([Uint8Array.from(atob(modelBytes.data), c => c.charCodeAt(0))], { type: modelBytes.mimeType || 'image/jpeg' })
      : null

    const promptParts = [shootPrompt.prompt]
    if (modelBlob) {
      promptParts.push(`Model Reference: The human in this shoot must resemble the model reference image exactly — same face, build, and appearance. They must be wearing the product from Image 0.`)
    }
    const finalPrompt = promptParts.join('\n\n')

    const quality = (pkg.modelType === 'infographic' || pkg.modelType === 'ui_mockup') ? 'high' : 'medium'

    // Order assets to match the manifest that PromptMaker built.
    // orderedAssetIds tells us the full-image order; crops follow each asset immediately after.
    const orderedAssets = shootPrompt.orderedAssetIds.length > 0
      ? shootPrompt.orderedAssetIds
          .map(id => allAssets.find(a => a.id === id))
          .filter((a): a is AssetWithSpec => !!a)
      : [pkg.asset, ...allAssets.filter(a => a.id !== pkg.asset.id)]

    const buildForm = () => {
      const f = new FormData()
      f.append('model', 'gpt-image-2')
      f.append('prompt', finalPrompt)
      f.append('size', '1536x1024')
      f.append('quality', quality)
      f.append('n', '1')

      // Full-view images in priority order, crops appended immediately after each asset
      for (const asset of orderedAssets) {
        const bytes = Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0))
        f.append('image[]', new Blob([bytes], { type: asset.mimeType || 'image/jpeg' }), `asset_${asset.id}.jpg`)

        if (asset.crops && asset.crops.length > 0) {
          for (const crop of asset.crops) {
            const cropBytes = Uint8Array.from(atob(crop.data), c => c.charCodeAt(0))
            f.append('image[]', new Blob([cropBytes], { type: crop.mimeType || 'image/jpeg' }), `crop_${crop.name}.jpg`)
          }
        }
      }

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

    const r2Key = `photoshoots/${userId}/${projectId}/${Date.now()}-shot${shootPrompt.shootIndex}.jpg`
    await this.env.ASSETS_BUCKET.put(
      r2Key,
      base64ToArrayBuffer(b64),
      { httpMetadata: { contentType: 'image/png' } }
    )

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
      generatedBase64: b64,
    }
  }
}
