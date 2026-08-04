import { OpenAITextService } from '../openai/OpenAITextService'
import { IntentDecoder } from './IntentDecoder'
import { GarmentForensics } from './GarmentForensics'
import { MultiViewSynthesizer } from './MultiViewSynthesizer'
import { ShootRouter, RawAsset } from './ShootRouter'
import { ProductIsolator } from './ProductIsolator'
import { PromptReviewer } from './PromptReviewer'
import { ImageQualityReviewer } from './ImageQualityReviewer'
import { AssetLabeler } from './AssetLabeler'
import { ShootPlanner } from './ShootPlanner'
import { PromptMaker } from './PromptMaker'
import { ImageGenerator } from './ImageGenerator'
import { PreprocessorClient } from './PreprocessorClient'
import { fetchR2AsBase64, base64ToArrayBuffer } from '../../lib/r2'
import { getDb } from '../../db'
import { assets, privateAssets } from '../../db/schema'
import { inArray } from 'drizzle-orm'
import { ShootEngineInput, AssetWithSpec, ProductGroup, IntentPlan, ShootPackage, ProductSpec, ViewType, ViewAnnotation, AssetTag } from '../../types/shoots'

// ── Tag helpers ────────────────────────────────────────────────────────────────

const VIEW_TYPE_PRIORITY: Record<ViewType, number> = {
  full_front: 0,
  three_quarter: 1,
  full_back: 2,
  side: 3,
  flat_lay: 4,
  detail_top: 5,
  detail_bottom: 5,
  detail_center: 5,
  detail_texture: 5,
  lifestyle: 6,
  packaging: 7,
  unknown: 8,
}

const VIEW_TYPE_CONTRIBUTES: Record<ViewType, string> = {
  full_front: 'primary front face and overall form',
  full_back: 'back construction and closure details',
  three_quarter: '3/4 angle showing depth and volume',
  side: 'side profile and silhouette depth',
  detail_top: 'top/collar/cap zone detail',
  detail_bottom: 'bottom/hem/base zone detail',
  detail_center: 'center/label/waist zone detail',
  detail_texture: 'fabric/material texture close-up',
  flat_lay: 'flat layout showing overall form',
  lifestyle: 'in-use lifestyle reference',
  packaging: 'packaging and labeling reference',
  unknown: 'supplementary product reference',
}

function inferCategory(productLabel: string): string {
  const l = productLabel.toLowerCase()
  if (/shirt|dress|pants|jacket|hoodie|skirt|shorts|blouse|knitwear|sweater|saree|kurta|lehenga|top|trouser|jeans|coat|suit|vest/.test(l)) return 'apparel'
  if (/shoe|sneaker|boot|sandal|slipper|heel|loafer|mule/.test(l)) return 'footwear'
  if (/lipstick|mascara|foundation|blush|eyeshadow|makeup|cosmetic/.test(l)) return 'beauty'
  if (/serum|moisturizer|cream|lotion|toner|sunscreen|cleanser|skincare/.test(l)) return 'skincare'
  if (/phone|laptop|headphone|speaker|tablet|charger|electronics|earphone/.test(l)) return 'electronics'
  if (/mug|cup|plate|bowl|glass|jar|bottle|tumbler|tableware|cutlery/.test(l)) return 'tableware'
  if (/sofa|chair|table|desk|shelf|ottoman|furniture|stool/.test(l)) return 'furniture'
  if (/towel|sheet|duvet|pillow|blanket|rug|curtain|linen|quilt|throw|bedding/.test(l)) return 'homeware'
  if (/bag|purse|wallet|clutch|backpack|handbag|tote/.test(l)) return 'bags'
  if (/ring|necklace|bracelet|earring|jewellery|jewelry|pendant|chain/.test(l)) return 'jewellery'
  if (/watch|belt|scarf|hat|sunglasses|cap/.test(l)) return 'accessories'
  if (/food|snack|chocolate|candy|biscuit|cake|cookie/.test(l)) return 'food'
  if (/can|beverage|drink|juice|soda|beer|wine/.test(l)) return 'beverage'
  return 'other'
}

function specFromTag(tag: AssetTag): ProductSpec {
  return {
    productType: tag.productLabel,
    category: inferCategory(tag.productLabel),
    materials: [],
    finish: '',
    colorProfile: { primary: '', pattern: 'solid' },
    formGeometry: '',
    dimensions: '',
    spatialAnchor: '',
    keyDetails: [],
    premiumDetails: [],
    contrastBoundary: '',
  }
}

export interface ShootEnv {
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string
  OPENAI_API_KEY: string
  DATABASE_URL: string
  ASSETS_BUCKET: any
  PREPROCESSOR_URL?: string
  REMOVE_BG_API_KEY?: string
  PINTEREST_COOKIE?: string
  BROWSERBASE_API_KEY?: string
  BROWSERBASE_PROJECT_ID?: string
  STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL"
  PINTEREST_EMAIL?: string
  PINTEREST_PASSWORD?: string
  API_URL?: string
}

type StreamFn = (event: object) => Promise<void>

export class ShootEngine {
  private openai: OpenAITextService
  private intentDecoder: IntentDecoder
  private forensics: GarmentForensics
  private synthesizer: MultiViewSynthesizer
  private router: ShootRouter
  private assetLabeler: AssetLabeler
  private planner: ShootPlanner
  private promptMaker: PromptMaker
  private promptReviewer: PromptReviewer
  private imageQualityReviewer: ImageQualityReviewer
  private imageGenerator: ImageGenerator

  constructor(private env: ShootEnv) {
    this.openai = new OpenAITextService(env.OPENAI_API_KEY)
    this.intentDecoder = new IntentDecoder(this.openai)
    this.forensics = new GarmentForensics(this.openai)
    this.synthesizer = new MultiViewSynthesizer(this.openai)
    this.router = new ShootRouter(this.openai)
    this.assetLabeler = new AssetLabeler(this.openai)
    this.planner = new ShootPlanner(this.openai)
    this.promptMaker = new PromptMaker(this.openai)
    this.promptReviewer = new PromptReviewer(this.openai)
    this.imageQualityReviewer = new ImageQualityReviewer(this.openai)
    this.imageGenerator = new ImageGenerator(env)
  }

  async run(input: ShootEngineInput, stream: StreamFn): Promise<void> {
    const { intent, assetIds, projectId, userId, modelR2Keys, dryRun } = input
    const hasModels = !!(modelR2Keys && modelR2Keys.length > 0)
    const runId = crypto.randomUUID()
    const runTs = Date.now()

    const debug: any = {
      runId,
      timestamp: new Date(runTs).toISOString(),
      intent,
      assetIds,
      projectId,
      userId,
      groups: [],
    }

    // ── Stage 1: Fetch all raw images ──────────────────────────────────────
    await stream({ type: 'status', content: 'Loading your product images...' })
    const rawAssets = await this.fetchRawAssets(assetIds, stream, input.assetTags)

    if (rawAssets.length === 0) {
      await stream({ type: 'error', message: 'No valid assets found. Please check your asset IDs.' })
      return
    }

    // ── Stage 1b: Isolate products — white background via gpt-image-2 ──────
    // Runs on every image before analysis or routing.
    // Gives analysis and generation a clean product reference regardless of source image quality.
    // Falls back to original silently if isolation fails.
    await stream({ type: 'status', content: `Isolating ${rawAssets.length} product(s)...` })
    const isolator = new ProductIsolator(this.env.OPENAI_API_KEY)
    await Promise.all(rawAssets.map(async raw => {
      try {
        const isolated = await isolator.isolate(raw.base64, raw.mimeType)
        raw.base64 = isolated.data
        raw.mimeType = isolated.mimeType

        // Save isolated image to R2 and stream it so frontend can display it
        const isolatedKey = `isolated/${userId}/${projectId}/${raw.id}.png`
        try {
          await this.env.ASSETS_BUCKET.put(
            isolatedKey,
            base64ToArrayBuffer(isolated.data),
            { httpMetadata: { contentType: 'image/png' } }
          )
          await stream({
            type: 'isolated',
            assetId: raw.id,
            url: `/assets/download?key=${encodeURIComponent(isolatedKey)}`,
            r2Key: isolatedKey,
          })
        } catch (saveErr: any) {
          console.warn(`[ShootEngine] Failed to save isolated image for ${raw.id}:`, saveErr.message)
        }
      } catch (err: any) {
        console.warn(`[ShootEngine] Isolation failed for ${raw.id}, using original:`, err.message)
      }
    }))
    await stream({ type: 'status', content: 'Products isolated on white background' })

    // ── Stage 2: Route — group images by product + map per-group intent ────
    await stream({ type: 'status', content: rawAssets.length > 1 ? `Identifying products across ${rawAssets.length} images...` : 'Identifying your product...' })
    const { groups } = await this.router.route(rawAssets, intent)

    await stream({
      type: 'status',
      content: groups.length > 1
        ? `Found ${groups.length} products: ${groups.map(g => g.productLabel).join(' · ')}`
        : `Product identified: ${groups[0].productLabel}`
    })
    debug.groups = groups.map(g => ({ groupId: g.groupId, productLabel: g.productLabel, assetIds: g.assetIds }))

    // ── Stage 3: Load model reference image ───────────────────────────────
    let modelBytes: { data: string; mimeType: string } | null = null
    if (hasModels) {
      await stream({ type: 'status', content: 'Loading model reference...' })
      const frontKey = modelR2Keys!.find(k => k.includes('-front.')) ?? modelR2Keys![0]
      try {
        modelBytes = await fetchR2AsBase64(this.env.ASSETS_BUCKET, frontKey)
      } catch (err: any) {
        console.warn('[ShootEngine] Could not load model reference image:', err.message)
      }
    }

    // ── Stage 4: Per-group pipeline ────────────────────────────────────────
    let globalShootIndex = 0

    for (const group of groups) {
      if (groups.length > 1) {
        await stream({ type: 'status', content: `── Starting shoots for: ${group.productLabel} ──` })
      }

      const groupDebug: any = { groupId: group.groupId, productLabel: group.productLabel, assets: [], shootPackages: [], shoots: [] }
      debug.groups.find((g: any) => g.groupId === group.groupId).detail = groupDebug

      // 4a: Analyze group assets (multi-view synthesis or single forensics)
      await stream({ type: 'status', content: `Analyzing ${group.productLabel}...` })
      const groupRaw = rawAssets.filter(r => group.assetIds.includes(r.id))
      const groupAssets = await this.analyzeGroup(groupRaw, stream, groupDebug, group.productLabel)

      if (groupAssets.length === 0) {
        await stream({ type: 'status', content: `No valid images for ${group.productLabel}, skipping...` })
        continue
      }

      // 4b: Asset labeling + crop extraction
      await stream({ type: 'status', content: `Planning detail extractions for ${group.productLabel}...` })
      const assetLabels = await this.assetLabeler.label(groupAssets, group.intentPlan)
      groupDebug.assetLabels = assetLabels

      if (this.env.PREPROCESSOR_URL) {
        const preprocessor = new PreprocessorClient(this.env.PREPROCESSOR_URL)
        for (const label of assetLabels) {
          const asset = groupAssets.find(a => a.id === label.assetId)
          if (!asset) continue
          const detailCrops = label.requestedCrops.filter(c => c.region !== 'full')
          if (detailCrops.length === 0) continue
          try {
            const zoneCrops = await preprocessor.preprocessCustom(asset.base64, asset.mimeType, detailCrops)
            const savedCrops: Array<{ name: string; description: string; data: string; mimeType: string }> = []
            for (const [name, crop] of Object.entries(zoneCrops)) {
              const cropR2Key = `crops/${userId}/${projectId}/${asset.id}/${name}.jpg`
              try {
                await this.env.ASSETS_BUCKET.put(
                  cropR2Key,
                  base64ToArrayBuffer(crop.data),
                  { httpMetadata: { contentType: crop.mimeType || 'image/jpeg' } }
                )
                const cropUrl = `/assets/download?key=${encodeURIComponent(cropR2Key)}`
                await stream({
                  type: 'crop',
                  assetId: asset.id,
                  cropName: name,
                  description: detailCrops.find(c => c.name === name)?.description ?? name,
                  url: cropUrl,
                  r2Key: cropR2Key,
                })
              } catch (err: any) {
                console.warn(`[ShootEngine] Failed to save crop ${name} to R2:`, err.message)
              }
              savedCrops.push({
                name,
                description: detailCrops.find(c => c.name === name)?.description ?? name,
                data: crop.data,
                mimeType: crop.mimeType,
              })
            }
            asset.crops = savedCrops
            await stream({ type: 'status', content: `Extracted ${asset.crops.length} detail crop(s) for ${group.productLabel}` })
          } catch (err: any) {
            console.warn(`[ShootEngine] Crop extraction failed for ${label.assetId}:`, err.message)
          }
        }
      }

      for (const label of assetLabels) {
        await stream({ type: 'status', content: `Asset: "${label.label}" [${label.role}]` })
      }

      // 4c: Plan shoots for this group
      await stream({ type: 'status', content: `Building shoot plan for ${group.productLabel}...` })
      const shootPackages = await this.planner.plan(group.intentPlan, groupAssets, hasModels)
      groupDebug.shootPackages = shootPackages.map(p => ({
        shootIndex: p.shootIndex,
        theme: p.theme,
        angle: p.angle,
        modelType: p.modelType,
        assetId: p.asset.id,
      }))

      await stream({
        type: 'plan',
        summary: `${shootPackages.length} shoots planned for ${group.productLabel}`,
        steps: shootPackages.map(p => ({
          index: globalShootIndex + p.shootIndex,
          theme: p.theme,
          angle: p.angle,
          garment: p.asset.productSpec.productType,
        }))
      })

      // 4d: Generate each shoot in this group
      for (const pkg of shootPackages) {
        try {
          const assetLabel = assetLabels.find(l => l.assetId === pkg.asset.id)
          const availableZones = (assetLabel?.requestedCrops ?? [])
            .map(c => ({ name: c.name, description: c.description }))

          // Only send images that belong to THIS shoot's product.
          // Same-product multi-view images (viewAnnotation set) are included as supplementary reference.
          // Different product variants in the group are excluded — each shoot gets its own image only.
          const shootAssets = this.selectAssetsForShoot(pkg, groupAssets)

          await stream({ type: 'status', content: `Writing prompt for "${pkg.theme}"...` })
          const shootPrompt = await this.promptMaker.make(pkg, shootAssets, availableZones, group.intentPlan.stylingDirectives)

          // Review prompt for physical realism — scale, proportion, placement only
          const reviewedPromptText = await this.promptReviewer.review(shootPrompt.prompt, pkg)
          const finalShootPrompt = reviewedPromptText !== shootPrompt.prompt
            ? { ...shootPrompt, prompt: reviewedPromptText }
            : shootPrompt

          const useModel = modelBytes && (pkg.modelType === 'on_model' || pkg.modelType === 'lifestyle')
          const absoluteIndex = globalShootIndex + pkg.shootIndex

          if (dryRun) {
            // Build the same finalPrompt and image list that ImageGenerator would assemble,
            // but emit them for inspection instead of calling OpenAI.
            const promptParts = [finalShootPrompt.prompt]
            if (useModel) {
              promptParts.push(`Model Reference: The human in this shoot must resemble the model reference image exactly — same face, build, and appearance. They must be wearing the product from Image 0.`)
            }
            const finalPromptText = promptParts.join('\n\n')

            const orderedDryAssets = finalShootPrompt.orderedAssetIds.length > 0
              ? finalShootPrompt.orderedAssetIds
                  .map(id => shootAssets.find(a => a.id === id))
                  .filter((a): a is AssetWithSpec => !!a)
              : [pkg.asset, ...shootAssets.filter(a => a.id !== pkg.asset.id)]

            const images: Array<{ name: string; mimeType: string; assetId?: string; r2Key?: string; cropName?: string }> = []
            for (const asset of orderedDryAssets) {
              images.push({ name: `asset_${asset.id}`, mimeType: asset.mimeType || 'image/jpeg', assetId: asset.id, r2Key: asset.r2Key })
              if (asset.crops) {
                for (const crop of asset.crops) {
                  images.push({ name: `crop_${crop.name}`, mimeType: crop.mimeType || 'image/jpeg', assetId: asset.id, cropName: crop.name })
                }
              }
            }
            if (useModel && modelBytes) {
              images.push({ name: 'model', mimeType: modelBytes.mimeType || 'image/jpeg' })
            }

            groupDebug.shoots.push({ shootIndex: absoluteIndex, theme: pkg.theme, prompt: finalPromptText })
            await stream({
              type: 'prompt',
              shootIndex: absoluteIndex,
              theme: pkg.theme,
              angle: pkg.angle,
              modelType: pkg.modelType,
              productLabel: group.productLabel,
              prompt: finalPromptText,
              imageManifest: finalShootPrompt.imageManifest,
              images,
            })
            continue
          }

          await stream({ type: 'status', content: `Generating: ${pkg.theme}...` })
          let shot = await this.imageGenerator.generate(
            { ...finalShootPrompt, shootIndex: absoluteIndex },
            pkg, shootAssets, userId, projectId,
            useModel ? modelBytes : null,
          )

          // ── Single quality check pass ──────────────────────────────────────
          // Vision model compares generated image vs original product reference.
          // If the product identity is wrong, correct the prompt and regenerate once.
          if (shot.generatedBase64) {
            await stream({ type: 'status', content: `Reviewing quality for "${pkg.theme}"...` })
            const review = await this.imageQualityReviewer.review(
              shot.generatedBase64,
              pkg.asset.base64,
              pkg.asset.mimeType,
              finalShootPrompt.prompt,
              pkg,
            )
            if (review.hasIssues && review.correctedPrompt) {
              await stream({ type: 'status', content: `Issue found: ${review.issue}. Regenerating with correction...` })
              shot = await this.imageGenerator.generate(
                { ...finalShootPrompt, prompt: review.correctedPrompt, shootIndex: absoluteIndex },
                pkg, shootAssets, userId, projectId,
                useModel ? modelBytes : null,
              )
            }
          }

          groupDebug.shoots.push({
            shootIndex: absoluteIndex,
            theme: pkg.theme,
            prompt: shootPrompt.prompt,
            r2Key: shot.r2Key,
          })

          await stream({
            type: 'photoshoots',
            items: [{
              shotIndex: shot.shootIndex,
              url: shot.url,
              concept: shot.concept,
              theme: shot.theme,
              assetId: shot.assetId,
              r2Key: shot.r2Key,
              productLabel: group.productLabel,
            }]
          })

        } catch (err: any) {
          console.error(`[ShootEngine] Shoot "${pkg.theme}" failed:`, err.message)
          await stream({ type: 'status', content: `Shoot "${pkg.theme}" failed: ${err.message}` })
        }
      }

      globalShootIndex += shootPackages.length
    }

    // ── Save debug log ─────────────────────────────────────────────────────
    if (this.env.PREPROCESSOR_URL) {
      try {
        const res = await fetch(`${this.env.PREPROCESSOR_URL}/debug/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(debug),
          signal: AbortSignal.timeout(5_000),
        })
        if (res.ok) {
          const { saved } = await res.json() as any
          console.log(`[ALLORE_DEBUG][run_saved] debug-runs/${saved}`)
          await stream({ type: 'status', content: `Debug log saved → debug-runs/${saved}` })
        }
      } catch (err: any) {
        console.warn('[ShootEngine] Could not save debug log:', err.message)
      }
    }

    await stream({ type: 'done', totalShots: globalShootIndex })
  }

  // Fetch raw images from R2, attaching any client-provided tags
  private async fetchRawAssets(assetIds: string[], stream: StreamFn, assetTags?: Record<string, AssetTag>): Promise<RawAsset[]> {
    const db = getDb(this.env.DATABASE_URL)

    const publicRows = await db.select().from(assets).where(inArray(assets.id, assetIds))
    const privateRows = await db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds))

    const assetMap = new Map<string, { id: string; r2Key: string }>()
    for (const a of publicRows) assetMap.set(a.id, { id: a.id, r2Key: a.url })
    for (const a of privateRows) assetMap.set(a.id, { id: a.id, r2Key: a.r2Key })

    const result: RawAsset[] = []
    for (const id of assetIds) {
      const record = assetMap.get(id)
      if (!record) {
        await stream({ type: 'status', content: `Asset ${id} not found, skipping...` })
        continue
      }
      try {
        const { data: base64, mimeType } = await fetchR2AsBase64(this.env.ASSETS_BUCKET, record.r2Key)
        result.push({ id: record.id, r2Key: record.r2Key, base64, mimeType, tag: assetTags?.[id] })
      } catch (err: any) {
        console.error(`[ShootEngine] Failed to fetch asset ${id}:`, err.message)
        await stream({ type: 'status', content: `Failed to load asset ${id}: ${err.message}` })
      }
    }

    return result
  }

  // Analyze a group of raw assets → AssetWithSpec[]
  // If assets have client-provided tags: skip all vision classification, build spec from tags.
  // Single image (no tag) → GarmentForensics
  // Multiple images, same product (no tag) → MultiViewSynthesizer (canonical spec + viewAnnotation set)
  // Multiple images, different products (no tag) → individual forensics per asset (no viewAnnotation)
  private async analyzeGroup(rawGroup: RawAsset[], stream: StreamFn, debug: any, productHint?: string): Promise<AssetWithSpec[]> {
    if (rawGroup.length === 0) return []

    // Fast path: client provided tags — no vision classification needed.
    // Use the group-level productHint (from router's LLM grouping) for the spec so all assets
    // in a merged collection share the same product identity.
    // Each asset's individual tag label goes into viewAnnotation.contributes for prompt context.
    if (rawGroup.every(r => r.tag?.productLabel)) {
      const specLabel = productHint ?? rawGroup[0].tag!.productLabel
      const result: AssetWithSpec[] = rawGroup.map(raw => {
        const productSpec = specFromTag({ productLabel: specLabel, viewType: raw.tag!.viewType })
        const viewAnnotation: ViewAnnotation | undefined = rawGroup.length > 1
          ? {
              assetId: raw.id,
              viewType: raw.tag!.viewType,
              contributes: `${raw.tag!.productLabel} — ${VIEW_TYPE_CONTRIBUTES[raw.tag!.viewType]}`,
              priority: VIEW_TYPE_PRIORITY[raw.tag!.viewType],
            }
          : undefined
        debug.assets.push({ id: raw.id, productSpec, viewAnnotation, source: 'tag' })
        return { ...raw, productSpec, viewAnnotation }
      })
      await stream({
        type: 'status',
        content: rawGroup.length > 1
          ? `${specLabel} — ${rawGroup.length} images tagged (${rawGroup.map(r => r.tag!.productLabel).join(', ')})`
          : `${rawGroup[0].tag!.productLabel} (${rawGroup[0].tag!.viewType})`,
      })
      return result
    }

    if (rawGroup.length === 1) {
      await stream({ type: 'status', content: 'Running product forensics...' })
      const productSpec = await this.forensics.analyze(rawGroup[0].base64, rawGroup[0].mimeType, productHint)
      await stream({
        type: 'status',
        content: `${productSpec.productType} (${productSpec.category}) — ${productSpec.colorProfile.primary}, ${productSpec.finish}`
      })
      debug.assets.push({ id: rawGroup[0].id, productSpec })
      return [{ ...rawGroup[0], productSpec }]
    }

    await stream({ type: 'status', content: `Synthesizing from ${rawGroup.length} views...` })
    const fusion = await this.synthesizer.analyze(rawGroup, productHint)

    if (fusion.isSameProduct) {
      // All images are views of the same product — use canonical spec and tag with viewAnnotation.
      // viewAnnotation presence is the signal used downstream to include these as supplementary refs.
      await stream({
        type: 'status',
        content: `${fusion.canonicalSpec.productType} — ${rawGroup.length} views fused into one identity`,
      })
      console.log('[ALLORE_DEBUG][fusion_same]', JSON.stringify({
        productType: fusion.canonicalSpec.productType,
        views: fusion.viewAnnotations.map(v => `${v.viewType} (priority ${v.priority})`),
      }, null, 2))
      return rawGroup.map(raw => {
        const annotation = fusion.viewAnnotations.find(v => v.assetId === raw.id)
        debug.assets.push({ id: raw.id, productSpec: fusion.canonicalSpec, viewAnnotation: annotation })
        return { ...raw, productSpec: fusion.canonicalSpec, viewAnnotation: annotation }
      })
    } else {
      // Router grouped different product variants together — fall back to individual forensics.
      // No viewAnnotation set, so selectAssetsForShoot will treat each as its own independent image.
      await stream({ type: 'status', content: 'Multiple distinct variants detected — analyzing each individually...' })
      const result: AssetWithSpec[] = []
      for (const raw of rawGroup) {
        const productSpec = await this.forensics.analyze(raw.base64, raw.mimeType, productHint)
        await stream({ type: 'status', content: `${productSpec.productType} — ${productSpec.colorProfile.primary}` })
        debug.assets.push({ id: raw.id, productSpec })
        result.push({ ...raw, productSpec })
      }
      return result
    }
  }

  // For a given shoot package, return only the images that should be sent to GPT-image-2.
  // Rule: always include the assigned primary asset.
  // Also include other assets from the group ONLY if they have viewAnnotation set —
  // meaning MultiViewSynthesizer confirmed they are views of the same physical product.
  // Different product variants (no viewAnnotation) are excluded — each shoot gets its own image.
  private selectAssetsForShoot(pkg: ShootPackage, groupAssets: AssetWithSpec[]): AssetWithSpec[] {
    const primary = pkg.asset
    const sameProductViews = groupAssets.filter(a =>
      a.id !== primary.id &&
      a.viewAnnotation !== undefined
    )
    return [primary, ...sameProductViews]
  }
}
