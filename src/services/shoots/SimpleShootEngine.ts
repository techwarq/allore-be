import { OpenRouterTextService, OPENROUTER_MODELS } from '../../core/ai-models/openrouter/OpenRouterTextService'
import { FalService } from '../../core/ai-models/fal/FalService'
import { StorytellingEngineService } from '../storytellingEngine.service'
import { fetchR2AsBase64, getSignedR2Url } from '../../lib/r2'
import { getDb } from '../../db'
import { assets, privateAssets } from '../../db/schema'
import { inArray } from 'drizzle-orm'
import { SimpleShootInput, GeneratedShot } from '../../types/shoots'

// @ts-ignore — text module via wrangler rules
import seedreamPromptGuide from './skills/seedream-prompt-guide.md'

export interface SimpleShootEnv {
  OPENROUTER_API_KEY: string
  FAL_KEY: string
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID?: string
  VERTEX_LOCATION?: string
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string
  QDRANT_URL: string
  QDRANT_API_KEY?: string
  DATABASE_URL: string
  ASSETS_BUCKET: any
  API_URL?: string
}

type StreamFn = (event: object) => Promise<void>

interface ShotAngle {
  shootIndex: number
  angle: string
  composition: string
}

interface CreativeDirection {
  productDescription: string
  labelText: string[]
  needsIsolation: boolean
  bigIdea: string
  world: string
  mood: string
  lightingDirection: string
  colorDirection: string
  shots: ShotAngle[]
}

// ── Stage 1: Creative Director — concept/story, not image mechanics ──────────
function buildCreativeDirectorSystem(count: number, hasModel: boolean, hasVibe: boolean): string {
  return `You are an award-winning creative director for premium product ad campaigns — the kind who
directs shoots for brands like Aesop, Jacquemus, Apple, Loewe.

You are given one or more reference images of a real product${hasModel ? ', a reference image of the AI model who will wear/use it' : ''}${hasVibe ? ', a mood/vibe reference image' : ''}, a brief from the user describing the
shoot they want, and optionally a handful of retrieved shoot-style insights from a style knowledge
base (inspiration only, not literal instructions).
${hasModel ? `
${hasVibe ? 'The image immediately after the product image(s)' : 'The LAST reference image'} is the AI MODEL, not the product — a specific person's likeness to preserve
exactly (face, build, styling) in every shot. Every other product reference image shows the product itself. Do
not confuse the two: never flag the model image for isolation, and every shot's composition must
include the model wearing/using/holding the product, not just the product alone.
` : ''}${hasVibe ? `
The LAST reference image is a MOOD/VIBE reference the user picked — it does NOT contain this product or
model, it is inspiration only. Study its lighting quality, color palette, composition, and atmosphere,
and let that genuinely shape your World/Mood/Lighting/Color direction below. Never describe it as if it
appears in the output, never flag it for isolation, and never transcribe label text from it — it is not
a product reference.
` : ''}
Your job has four parts:

1. PRODUCT IDENTIFICATION — look at the reference image(s) and identify exactly what the product is:
   category, shape, color, material, distinguishing details. Then TRANSCRIBE every piece of visible
   label/packaging text VERBATIM, word for word, exactly as printed — do not paraphrase or guess, zoom
   in mentally on small print. This transcription is required downstream to render text accurately;
   skipping or approximating it will cause the final image to have garbled text.

2. ISOLATION CHECK — determine whether the product needs to be extracted from its current context
   before it can be used as a clean generation reference. Set "needsIsolation": true ONLY when there is
   clear, unambiguous evidence the product is NOT already isolated — worn by a visible model, displayed
   on a mannequin/velvet bust/jewelry stand, held in a visible hand, sitting in original packaging, or
   with people/other objects/a busy environment prominently in frame that are NOT part of the product
   itself. Default to "needsIsolation": false — this includes any product already shown on a plain,
   white, neutral, or simple studio background, a flat lay, or otherwise already reasonably clean, even
   if not perfectly white. Isolation is a real extra generation step that costs time and can itself
   subtly alter the product — do not run it speculatively. If you are not confident there is an actual
   holder/mannequin/hand/busy-background problem to solve, set it to false.

3. CREATIVE DIRECTION — do not think "how do I photograph this product?" Think: "what story, world, or
   feeling does this product belong in?" Develop ONE cohesive creative concept for this shoot,
   following the user's brief:
   - Big idea: the single emotional/conceptual hook driving the shoot, one sentence.
   - World: the physical scene/environment/story — specific, textured, intentional. Not "nice
     background" — an actual place with materials, weather, time of day.
   - Mood: 3-5 evocative words.
   - Lighting direction: cinematic lighting language — time of day, direction, quality, color temperature.
   - Color direction: the palette/color-grade language for this shoot.
   CRITICAL: never default to gothic, dark, moody, or high-contrast/low-key lighting as your baseline —
   that is one option among many, not the "premium" default. Take the actual product category, brand
   tone, and user's brief${hasVibe ? ', and the vibe reference image,' : ''} as your only signal for mood; a skincare
   brand, a children's product, or a bright minimal brand should get airy/sunlit/pastel direction just as
   readily as something moody should when THAT'S what's actually indicated. Only go dark/gritty/moody when
   the brief, brand, or vibe reference genuinely calls for it.

4. SHOT BREAKDOWN — split into exactly ${count} shot${count > 1 ? 's' : ''}, each a variation on this
   SAME creative world. Only the camera angle/composition/framing changes shot to shot (low angle
   looking up, eye-level 3/4, overhead top-down, wide establishing, macro close-up on a detail,
   over-the-shoulder, etc.) — the big idea, world, mood, lighting, and color direction stay consistent
   across all shots unless the user's brief implies otherwise.

Return a JSON object of this exact shape:
{
  "productDescription": "...",
  "labelText": ["verbatim string 1", "verbatim string 2", ...],
  "needsIsolation": true | false,
  "bigIdea": "...",
  "world": "...",
  "mood": "...",
  "lightingDirection": "...",
  "colorDirection": "...",
  "shots": [
    { "shootIndex": 0, "angle": "...", "composition": "..." }
  ]
}
"shots" must contain exactly ${count} entries. Return raw JSON only — no preamble, no markdown.`
}

// ── Stage 2: Prompt Compiler — turns the creative direction into Seedream-ready prompts ──
function buildPromptCompilerSystem(hasModel: boolean, productImageCount: number): string {
  const modelImageNum = productImageCount + 1
  return `You are a prompt-compiling specialist for Seedream 5.0 Pro. You do not
invent creative direction — a creative director has already developed the concept; your only job is to
translate their direction into production-ready image-generation prompts.

You will be given: a product description, verbatim label text, the creative direction (big idea, world,
mood, lighting direction, color direction), and a list of shots each with their own camera angle/composition.

For EACH shot, write one complete, standalone Seedream prompt that:
1. Locks the product exactly as described — same shape, color, materials, proportions.
2. Quotes every piece of label text verbatim as given — phrase it like: the label reads exactly
   "X", "Y" — zero misspelling, zero reflow, zero invented characters. This is mandatory whenever
   labelText is non-empty.
3. Realizes the world/mood/lighting direction/color direction concretely and specifically for this
   shot's angle/composition — same creative world across all shots, different framing per shot.
4. References the product reference image as "Image 1" (and "Image 2", etc. if more than one exists).
${hasModel ? `5. This shoot includes an AI model — reference them explicitly as "Image ${modelImageNum}" in
   every prompt (e.g. "Image ${modelImageNum} shows the model — preserve their exact face, build, and
   styling") and describe them actively wearing/using/holding the product from Image 1, not standing
   apart from it.` : ''}

Return a JSON object {"prompts": ["<shot 1 prompt>", "<shot 2 prompt>", ...]} with exactly one prompt
per shot, in shootIndex order. Each entry is a complete standalone prompt — no numbering, no preamble,
no markdown.

---

Follow Seedream's prompting conventions exactly — image referencing, product-lock phrasing, coordinate
syntax if useful, and constraints below:

${seedreamPromptGuide}`
}

/**
 * Lightweight shoot pipeline: user query + reference images straight to generated shots.
 * Skips the forensics/routing/multi-stage analysis in ShootEngine, but keeps its two-stage
 * split — concept before mechanics:
 *   1. Creative Director stage — identifies the product, transcribes label text, and develops
 *      one creative concept (big idea/world/mood/lighting) broken into per-shot camera angles.
 *   2. Prompt Compiler stage — turns that concept into Seedream-ready prompts, one per shot.
 * Qwen 3.7 Flash (via OpenRouter) drives both stages; Seedream v5 (via Fal) generates/edits.
 */
export class SimpleShootEngine {
  private text: OpenRouterTextService
  private fal: FalService
  private storytellingEngine: StorytellingEngineService

  constructor(private env: SimpleShootEnv) {
    this.text = new OpenRouterTextService(env.OPENROUTER_API_KEY, { model: OPENROUTER_MODELS.QWEN_3_7_FLASH })
    this.fal = new FalService(env.FAL_KEY)
    this.storytellingEngine = new StorytellingEngineService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID || '',
      env.VERTEX_LOCATION || '',
      env.QDRANT_URL,
      env.QDRANT_API_KEY,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    )
  }

  async run(input: SimpleShootInput, stream: StreamFn): Promise<GeneratedShot[]> {
    const { query, assetIds, userId, projectId, modelR2Keys, vibeImageUrl } = input
    const count = input.count ?? 1

    await stream({ type: 'status', content: 'Loading reference images...' })
    const productImages = await this.fetchAssets(assetIds, stream)
    const modelImages = modelR2Keys?.length ? await this.fetchModelImages(modelR2Keys, stream) : []
    const hasModel = modelImages.length > 0
    // Vision-only reference for the Creative Director — never included in the
    // actual generation image list below, so its content (person/product/scene
    // in the picked Pinterest photo) can't leak into the output; only its
    // mood/lighting/composition informs the written creative direction.
    const vibeImage = vibeImageUrl ? await this.fetchExternalImage(vibeImageUrl, stream) : null

    await stream({ type: 'status', content: 'Searching shoot style references...' })
    const styleContext = await this.findStyleReferences(query)

    await stream({ type: 'status', content: 'Developing creative direction...' })
    const direction = await this.developCreativeDirection(query, productImages, modelImages, vibeImage, styleContext, count)
    await stream({
      type: 'creative_direction',
      bigIdea: direction.bigIdea,
      world: direction.world,
      mood: direction.mood,
      lightingDirection: direction.lightingDirection,
      colorDirection: direction.colorDirection,
      needsIsolation: direction.needsIsolation,
      shots: direction.shots,
    })

    // Isolation only ever applies to the product image(s) — the model reference
    // is already a clean generated portrait and must never be re-touched.
    let productImageUrls = productImages.map(img => `data:${img.mimeType};base64,${img.base64}`)
    if (direction.needsIsolation && productImageUrls.length > 0) {
      await stream({ type: 'status', content: 'Product is on a holder/mannequin — isolating it first...' })
      productImageUrls = await this.isolateProducts(productImageUrls, userId, projectId, stream)
    }
    const modelImageUrls = modelImages.map(img => `data:${img.mimeType};base64,${img.base64}`)
    const imageUrls = [...productImageUrls, ...modelImageUrls]

    await stream({
      type: 'status',
      content: count > 1 ? `Writing ${direction.shots.length} shot prompts (varied camera angles)...` : 'Writing shoot prompt...',
    })
    const prompts = await this.compilePrompts(direction, hasModel, productImages.length)

    const db = getDb(this.env.DATABASE_URL)
    const results: GeneratedShot[] = []

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]
      const angle = direction.shots[i]?.angle || direction.bigIdea
      await stream({ type: 'prompt', shootIndex: i, prompt })
      await stream({ type: 'status', content: `Generating shot ${i + 1}/${prompts.length}...` })

      let urls: string[]
      try {
        urls = imageUrls.length > 0
          ? await this.fal.editWithSeedream(prompt, imageUrls, { numImages: 1 })
          : await this.fal.generateSeedreamImage(prompt, { numImages: 1 })
      } catch (err: any) {
        console.error(`[SimpleShootEngine] Shot ${i} generation failed:`, err.message)
        await stream({ type: 'status', content: `Shot ${i + 1} failed: ${err.message}` })
        continue
      }

      if (urls.length === 0) {
        await stream({ type: 'status', content: `Shot ${i + 1} returned no image, skipping...` })
        continue
      }

      const imgRes = await fetch(urls[0])
      if (!imgRes.ok) {
        console.warn(`[SimpleShootEngine] Failed to fetch generated image ${i}: ${imgRes.status}`)
        continue
      }
      const buffer = await imgRes.arrayBuffer()

      const r2Key = `photoshoots/${userId}/${projectId}/${Date.now()}-shot${i}.jpg`
      await this.env.ASSETS_BUCKET.put(r2Key, buffer, { httpMetadata: { contentType: 'image/png' } })

      const assetId = crypto.randomUUID()
      await db.insert(privateAssets).values({
        id: assetId,
        userId,
        projectId: projectId === 'default' ? null : projectId,
        r2Key,
        type: 'photoshoot',
        metadata: { query, prompt, bigIdea: direction.bigIdea, angle, source: 'simple_shoot_engine' },
      })

      // Real signed R2 URL so an <img> tag can load it directly, with no session
      // cookie needed — same pattern AvatarGeneratorTool uses. Falls back to the
      // public download proxy if presigned URLs aren't supported (e.g. local R2).
      let shotUrl: string
      try {
        shotUrl = await getSignedR2Url(this.env.ASSETS_BUCKET, r2Key, 7200)
      } catch (err: any) {
        console.warn('[SimpleShootEngine] getSignedR2Url failed, falling back to proxy URL:', err.message)
        shotUrl = `${this.env.API_URL || ''}/assets/download?key=${encodeURIComponent(r2Key)}`
      }

      const shot: GeneratedShot = {
        shootIndex: i,
        r2Key,
        assetId,
        concept: direction.bigIdea || query,
        theme: angle,
        url: shotUrl,
      }
      results.push(shot)

      await stream({
        type: 'photoshoots',
        items: [{ shotIndex: shot.shootIndex, url: shot.url, concept: shot.concept, theme: shot.theme, assetId: shot.assetId, r2Key: shot.r2Key, prompt }],
      })
    }

    if (results.length === 0) {
      await stream({ type: 'error', message: 'Seedream returned no images.' })
      return []
    }

    await stream({ type: 'done', totalShots: results.length })
    return results
  }

  // Stage 1 — identifies the product/label text and develops one creative concept, broken
  // into per-shot camera angles. Vision call: this is the only stage that needs to look at
  // the reference images.
  private async developCreativeDirection(
    query: string,
    productImages: Array<{ base64: string; mimeType: string }>,
    modelImages: Array<{ base64: string; mimeType: string }>,
    vibeImage: { base64: string; mimeType: string } | null,
    styleContext: string,
    count: number
  ): Promise<CreativeDirection> {
    const userMessage = [
      `User brief: ${query}`,
      styleContext ? `Retrieved shoot-style insights (inspiration only):\n${styleContext}` : '',
    ].filter(Boolean).join('\n\n')

    // Model image goes right after the product(s), vibe reference always LAST —
    // matches buildCreativeDirectorSystem's positional description of each.
    const refImages = [...productImages, ...modelImages, ...(vibeImage ? [vibeImage] : [])]
    const system = buildCreativeDirectorSystem(count, modelImages.length > 0, !!vibeImage)
    const result = refImages.length > 0
      ? await this.text.chatWithMultipleImages(system, userMessage, refImages, true)
      : await this.text.chat(system, userMessage, true)

    const parsed = JSON.parse(result)
    const rawShots = Array.isArray(parsed?.shots) ? parsed.shots : []
    if (rawShots.length === 0) throw new Error('Creative director returned no shots')

    return {
      productDescription: String(parsed.productDescription || ''),
      labelText: Array.isArray(parsed.labelText) ? parsed.labelText.filter((t: unknown) => typeof t === 'string') : [],
      needsIsolation: parsed.needsIsolation === true,
      bigIdea: String(parsed.bigIdea || ''),
      world: String(parsed.world || ''),
      mood: String(parsed.mood || ''),
      lightingDirection: String(parsed.lightingDirection || ''),
      colorDirection: String(parsed.colorDirection || ''),
      shots: rawShots.slice(0, count).map((s: any, i: number) => ({
        shootIndex: typeof s?.shootIndex === 'number' ? s.shootIndex : i,
        angle: String(s?.angle || ''),
        composition: String(s?.composition || ''),
      })),
    }
  }

  // Stage 2 — turns the creative direction into Seedream-ready prompts. Text-only: the visual
  // analysis already happened in Stage 1 and is encoded in `direction`.
  private async compilePrompts(direction: CreativeDirection, hasModel: boolean, productImageCount: number): Promise<string[]> {
    const userMessage = JSON.stringify(direction, null, 2)
    const system = buildPromptCompilerSystem(hasModel, productImageCount)
    const result = await this.text.chat(system, userMessage, true)

    const parsed = JSON.parse(result)
    const prompts: string[] = Array.isArray(parsed?.prompts)
      ? parsed.prompts.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
      : []

    if (prompts.length === 0) throw new Error('Prompt compiler returned no usable prompts')
    return prompts.slice(0, direction.shots.length)
  }

  // Isolates each reference image onto a clean white background via a Seedream edit call (same
  // provider as the actual shoot generation — no OpenAI involved) so a display bust/mannequin/hand/
  // packaging doesn't leak into the generated scene. Saves a copy to R2 for preview, but returns
  // Fal's own hosted output URL for use as the next edit's input (our local dev server isn't
  // publicly reachable, so Fal can't be pointed back at our R2 download endpoint). Per-item
  // non-fatal — falls back to the original image URL if isolation fails for that one.
  private async isolateProducts(imageUrls: string[], userId: string, projectId: string, stream: StreamFn): Promise<string[]> {
    const isolationPrompt = `Product isolation task — e-commerce cutout style. Image 1 shows a product
that is currently displayed on or with something that is NOT the product itself (a mannequin, a velvet
or fabric display bust/stand, jewelry stand, packaging, a hand, a person wearing/holding it, or a
styled background/props). Your job is a hard cutout, not a re-photograph: identify the exact boundary
of the product only, delete everything else in the frame, and place just the product centered on a
seamless, flat, pure white (#FFFFFF) background — the same look as a studio product-catalog shot with
zero background elements.

HARD REQUIREMENTS:
- The display stand, bust, mannequin, fabric, hand, packaging, or any other holder must be COMPLETELY
  ABSENT from the output — not blurred, not faded, not partially visible — fully removed as if it was
  never there.
- Nothing else may appear in the frame: no props, no shadow of a person, no textured backdrop. Solid
  white only, edge to edge.
- The product's own shape, proportions, colors, materials, textures, and any label/engraved text must
  be preserved with 100% fidelity — do not alter, redesign, reinterpret, or "clean up" the product
  itself. Only the surrounding context changes.
- If the product was draped or resting on a holder (e.g. a necklace on a bust), reconstruct its natural
  unsupported shape the way it would look laid out for a product photo — do not leave a holder-shaped
  gap or invisible support in the silhouette.

This is a cutout/isolation operation, not a scene edit — treat the current display context as something
to delete entirely, not something to preserve or soften.`

    return Promise.all(imageUrls.map(async (url, i) => {
      try {
        const isolatedUrls = await this.fal.editWithSeedream(isolationPrompt, [url], { numImages: 1 })
        if (isolatedUrls.length === 0) return url
        const isolatedUrl = isolatedUrls[0]

        try {
          const imgRes = await fetch(isolatedUrl)
          if (imgRes.ok) {
            const buffer = await imgRes.arrayBuffer()
            const isolatedKey = `isolated/${userId}/${projectId}/${Date.now()}-${i}.png`
            await this.env.ASSETS_BUCKET.put(isolatedKey, buffer, { httpMetadata: { contentType: 'image/png' } })
            await stream({
              type: 'isolated',
              index: i,
              url: `/assets/download?key=${encodeURIComponent(isolatedKey)}`,
              r2Key: isolatedKey,
            })
          }
        } catch (saveErr: any) {
          console.warn(`[SimpleShootEngine] Failed to save isolated image ${i} to R2:`, saveErr.message)
        }

        return isolatedUrl
      } catch (err: any) {
        console.warn(`[SimpleShootEngine] Isolation failed for image ${i}, using original:`, err.message)
        return url
      }
    }))
  }

  // Non-fatal — same pattern as StorytellerTool: proceed without insights if Qdrant is down/empty.
  private async findStyleReferences(query: string): Promise<string> {
    try {
      const insights = await this.storytellingEngine.search(query, 5)
      const texts = insights.map((i: any) => i.payload?.text).filter(Boolean)
      return texts.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')
    } catch (err: any) {
      console.warn('[SimpleShootEngine] Storytelling engine search failed — continuing without style context:', err.message)
      return ''
    }
  }

  private async fetchAssets(assetIds: string[], stream: StreamFn): Promise<Array<{ base64: string; mimeType: string }>> {
    if (assetIds.length === 0) return []

    const db = getDb(this.env.DATABASE_URL)
    const publicRows = await db.select().from(assets).where(inArray(assets.id, assetIds))
    const privateRows = await db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds))

    const r2Keys = new Map<string, string>()
    for (const a of publicRows) r2Keys.set(a.id, a.url)
    for (const a of privateRows) r2Keys.set(a.id, a.r2Key)

    const result: Array<{ base64: string; mimeType: string }> = []
    for (const id of assetIds) {
      const r2Key = r2Keys.get(id)
      if (!r2Key) {
        await stream({ type: 'status', content: `Asset ${id} not found, skipping...` })
        continue
      }
      try {
        const { data, mimeType } = await fetchR2AsBase64(this.env.ASSETS_BUCKET, r2Key)
        result.push({ base64: data, mimeType })
      } catch (err: any) {
        console.warn(`[SimpleShootEngine] Failed to fetch asset ${id}:`, err.message)
        await stream({ type: 'status', content: `Failed to load asset ${id}: ${err.message}` })
      }
    }
    return result
  }

  // Model reference images are addressed by R2 key directly (avatar generation
  // stores them in private_assets, but the planner passes the key it already
  // has rather than the row id) — no DB lookup needed, unlike fetchAssets above.
  private async fetchModelImages(r2Keys: string[], stream: StreamFn): Promise<Array<{ base64: string; mimeType: string }>> {
    const result: Array<{ base64: string; mimeType: string }> = []
    for (const key of r2Keys) {
      try {
        const { data, mimeType } = await fetchR2AsBase64(this.env.ASSETS_BUCKET, key)
        result.push({ base64: data, mimeType })
      } catch (err: any) {
        console.warn(`[SimpleShootEngine] Failed to fetch model image ${key}:`, err.message)
        await stream({ type: 'status', content: `Failed to load model reference, continuing without it: ${err.message}` })
      }
    }
    return result
  }

  // Vibe reference is an arbitrary external URL (Pinterest CDN), not an R2 key —
  // fetched directly rather than through fetchAssets/fetchModelImages. Non-fatal:
  // the shoot still runs on text direction alone if this fails.
  private async fetchExternalImage(url: string, stream: StreamFn): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = await res.arrayBuffer()
      const mimeType = res.headers.get('content-type') || 'image/jpeg'
      let binary = ''
      const bytes = new Uint8Array(buffer)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      return { base64: btoa(binary), mimeType }
    } catch (err: any) {
      console.warn('[SimpleShootEngine] Failed to fetch vibe reference image, continuing without it:', err.message)
      await stream({ type: 'status', content: 'Vibe reference image unavailable, continuing without it...' })
      return null
    }
  }
}
