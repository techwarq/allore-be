import { TextService } from '../gemini/TextService'
import { IntentDecoder } from './IntentDecoder'
import { GarmentForensics } from './GarmentForensics'
import { ShootPlanner } from './ShootPlanner'
import { PromptMaker } from './PromptMaker'
import { ImageGenerator } from './ImageGenerator'
import { fetchR2AsBase64 } from '../../lib/r2'
import { getDb } from '../../db'
import { assets, privateAssets } from '../../db/schema'
import { inArray } from 'drizzle-orm'
import { ShootEngineInput, AssetWithSpec } from '../../types/shoots'

export interface ShootEnv {
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string
  OPENAI_API_KEY: string
  DATABASE_URL: string
  ASSETS_BUCKET: any
}

type StreamFn = (event: object) => Promise<void>

export class ShootEngine {
  private textService: TextService
  private intentDecoder: IntentDecoder
  private forensics: GarmentForensics
  private planner: ShootPlanner
  private promptMaker: PromptMaker
  private imageGenerator: ImageGenerator

  constructor(private env: ShootEnv) {
    this.textService = new TextService(
      env.GEMINI_API_KEY,
      env.VERTEX_PROJECT_ID,
      env.VERTEX_LOCATION,
      env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    )
    this.intentDecoder = new IntentDecoder(this.textService)
    this.forensics = new GarmentForensics(this.textService)
    this.planner = new ShootPlanner(this.textService)
    this.promptMaker = new PromptMaker(this.textService)
    this.imageGenerator = new ImageGenerator(env)
  }

  async run(input: ShootEngineInput, stream: StreamFn): Promise<void> {
    const { intent, assetIds, projectId, userId, modelR2Keys } = input
    const hasModels = !!(modelR2Keys && modelR2Keys.length > 0)

    // ── Stage 1: Decode intent ─────────────────────────────────────────────
    await stream({ type: 'status', content: 'Decoding your intent...' })
    const intentPlan = await this.intentDecoder.decode(intent, assetIds)
    await stream({
      type: 'status',
      content: `Planning ${intentPlan.countHint} shoots — ${intentPlan.overallStyle} style, ${intentPlan.mood}`
    })

    // ── Stage 2a: Pull product assets + forensics ─────────────────────────
    await stream({ type: 'status', content: 'Analyzing your garments...' })
    const assetsWithSpecs = await this.loadAndAnalyzeAssets(assetIds, stream)

    if (assetsWithSpecs.length === 0) {
      await stream({ type: 'error', message: 'No valid assets found. Please check your asset IDs.' })
      return
    }

    // ── Stage 2b: Load model reference image (front angle preferred) ──────
    let modelBytes: { data: string; mimeType: string } | null = null
    if (hasModels) {
      await stream({ type: 'status', content: 'Loading model reference...' })
      // Prefer the "front" angle key; fall back to first available
      const frontKey = modelR2Keys!.find(k => k.includes('-front.')) ?? modelR2Keys![0]
      try {
        modelBytes = await fetchR2AsBase64(this.env.ASSETS_BUCKET, frontKey)
      } catch (err: any) {
        console.warn('[ShootEngine] Could not load model reference image:', err.message)
      }
    }

    // ── Stage 2c: Plan shoots ──────────────────────────────────────────────
    await stream({ type: 'status', content: 'Building shoot plan...' })
    const shootPackages = await this.planner.plan(intentPlan, assetsWithSpecs, hasModels)
    await stream({
      type: 'plan',
      summary: `${shootPackages.length} shoots planned`,
      steps: shootPackages.map(p => ({
        index: p.shootIndex,
        theme: p.theme,
        angle: p.angle,
        garment: p.asset.productSpec.productType,
      }))
    })

    // ── Stages 3 + 4: Sequential — stream each image as it's ready ────────
    for (const pkg of shootPackages) {
      try {
        // Stage 3: Build prompt
        await stream({ type: 'status', content: `Writing prompt for shoot ${pkg.shootIndex + 1}: ${pkg.theme}...` })
        const shootPrompt = await this.promptMaker.make(pkg)

        // Stage 4: Generate image — pass model reference only for on_model / lifestyle shots
        const useModel = modelBytes && (pkg.modelType === 'on_model' || pkg.modelType === 'lifestyle')
        await stream({ type: 'status', content: `Generating shoot ${pkg.shootIndex + 1}/${shootPackages.length}: ${pkg.theme}...` })
        const shot = await this.imageGenerator.generate(
          shootPrompt, pkg, userId, projectId,
          useModel ? modelBytes : null
        )

        await stream({
          type: 'photoshoots',
          items: [{
            shotIndex: shot.shootIndex,
            url: shot.url,
            concept: shot.concept,
            theme: shot.theme,
            assetId: shot.assetId,
            r2Key: shot.r2Key,
          }]
        })

      } catch (err: any) {
        console.error(`[ShootEngine] Shoot ${pkg.shootIndex + 1} failed:`, err.message)
        await stream({
          type: 'status',
          content: `Shoot ${pkg.shootIndex + 1} failed: ${err.message}`
        })
      }
    }

    await stream({ type: 'done', totalShots: shootPackages.length })
  }

  private async loadAndAnalyzeAssets(assetIds: string[], stream: StreamFn): Promise<AssetWithSpec[]> {
    const db = getDb(this.env.DATABASE_URL)
    const result: AssetWithSpec[] = []

    // Fetch records from both tables
    const publicRows = await db.select().from(assets).where(inArray(assets.id, assetIds))
    const privateRows = await db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds))

    const assetMap = new Map<string, { id: string; r2Key: string }>()
    for (const a of publicRows) assetMap.set(a.id, { id: a.id, r2Key: a.url })
    for (const a of privateRows) assetMap.set(a.id, { id: a.id, r2Key: a.r2Key })

    for (const id of assetIds) {
      const record = assetMap.get(id)
      if (!record) {
        await stream({ type: 'status', content: `Asset ${id} not found, skipping...` })
        continue
      }

      try {
        await stream({ type: 'status', content: 'Fetching product image...' })
        const { data: base64, mimeType } = await fetchR2AsBase64(this.env.ASSETS_BUCKET, record.r2Key)

        await stream({ type: 'status', content: 'Running product forensics...' })
        const productSpec = await this.forensics.analyze(base64, mimeType)

        await stream({
          type: 'status',
          content: `Product identified: ${productSpec.productType} (${productSpec.category}) — ${productSpec.colorProfile.primary}, ${productSpec.finish}`
        })

        result.push({ id: record.id, r2Key: record.r2Key, mimeType, base64, productSpec })

      } catch (err: any) {
        console.error(`[ShootEngine] Asset ${id} analysis failed:`, err.message)
        await stream({ type: 'status', content: `Failed to analyze asset ${id}: ${err.message}` })
      }
    }

    return result
  }
}
