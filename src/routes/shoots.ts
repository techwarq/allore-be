import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ShootEngine } from '../services/shoots/ShootEngine'
import { SimpleShootEngine } from '../services/shoots/SimpleShootEngine'
import { getDb } from '../db'
import { users, projects } from '../db/schema'
import { eq } from 'drizzle-orm'

type ShootsBindings = {
  DATABASE_URL: string
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string
  OPENAI_API_KEY: string
  OPENROUTER_API_KEY: string
  FAL_KEY: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
  ASSETS_BUCKET: R2Bucket
  API_URL?: string
  PREPROCESSOR_URL?: string
}

const DEV_EMAIL = 'dev@alloreai.com'

async function resolveDevContext(databaseUrl: string): Promise<{ userId: string; projectId: string }> {
  const db = getDb(databaseUrl)
  const [user] = await db.select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1)
  if (!user) throw new Error('Dev user not found — call POST /dev/upload first to seed it')
  const [project] = await db.select().from(projects).where(eq(projects.userId, user.id)).limit(1)
  if (!project) throw new Error('Dev project not found — call POST /dev/upload first to seed it')
  return { userId: user.id, projectId: project.id }
}

const shoots = new Hono<{ Bindings: ShootsBindings }>()

/**
 * POST /shoots/generate
 * Streams a full photoshoot generation pipeline via SSE.
 * Body: { intent: string, assetIds: string[], projectId?: string, userId?: string }
 */
shoots.post('/generate', async (c) => {
  const body = await c.req.json()
  const { intent, assetIds, projectId, userId, assetTags } = body

  if (!intent || !Array.isArray(assetIds) || assetIds.length === 0) {
    return c.json({ error: 'Missing required fields: intent, assetIds' }, 400)
  }

  const engine = new ShootEngine({
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    OPENAI_API_KEY: c.env.OPENAI_API_KEY,
    DATABASE_URL: c.env.DATABASE_URL,
    ASSETS_BUCKET: c.env.ASSETS_BUCKET,
    PREPROCESSOR_URL: c.env.PREPROCESSOR_URL,
  })

  return streamSSE(c, async (stream) => {
    const send = async (event: object) => {
      await stream.write(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    }

    try {
      let resolvedUserId = userId
      let resolvedProjectId = projectId
      if (!resolvedUserId || resolvedUserId === 'dev') {
        const ctx = await resolveDevContext(c.env.DATABASE_URL)
        resolvedUserId = ctx.userId
        resolvedProjectId = resolvedProjectId || ctx.projectId
      }
      await engine.run({ intent, assetIds, projectId: resolvedProjectId || 'default', userId: resolvedUserId, assetTags }, send)
    } catch (err: any) {
      await send({ type: 'error', message: err.message || 'Shoot engine failed' })
    } finally {
      await stream.close()
    }
  })
})

/**
 * POST /shoots/plan
 * Dry-run: streams the full pipeline up through prompt generation but skips image model calls.
 * Returns 'prompt' SSE events with the final prompt text and image manifest for each shoot.
 * Body: same as /shoots/generate
 */
shoots.post('/plan', async (c) => {
  const body = await c.req.json()
  const { intent, assetIds, projectId, userId, assetTags } = body

  if (!intent || !Array.isArray(assetIds) || assetIds.length === 0) {
    return c.json({ error: 'Missing required fields: intent, assetIds' }, 400)
  }

  const engine = new ShootEngine({
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    OPENAI_API_KEY: c.env.OPENAI_API_KEY,
    DATABASE_URL: c.env.DATABASE_URL,
    ASSETS_BUCKET: c.env.ASSETS_BUCKET,
    PREPROCESSOR_URL: c.env.PREPROCESSOR_URL,
  })

  return streamSSE(c, async (stream) => {
    const send = async (event: object) => {
      await stream.write(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    }

    try {
      let resolvedUserId = userId
      let resolvedProjectId = projectId
      if (!resolvedUserId || resolvedUserId === 'dev') {
        const ctx = await resolveDevContext(c.env.DATABASE_URL)
        resolvedUserId = ctx.userId
        resolvedProjectId = resolvedProjectId || ctx.projectId
      }
      await engine.run(
        { intent, assetIds, projectId: resolvedProjectId || 'default', userId: resolvedUserId, assetTags, dryRun: true },
        send,
      )
    } catch (err: any) {
      await send({ type: 'error', message: err.message || 'Shoot engine failed' })
    } finally {
      await stream.close()
    }
  })
})

/**
 * POST /shoots/simple
 * Streams the lightweight pipeline: user query + reference images straight to shots —
 * no forensics/routing/multi-stage analysis. Qwen 3.7 Flash (OpenRouter) writes the
 * generation prompt, Seedream v5 (Fal) generates/edits the shots.
 * Body: { query: string, assetIds: string[], projectId?: string, userId?: string, count?: number }
 */
shoots.post('/simple', async (c) => {
  const body = await c.req.json()
  const { query, assetIds, projectId, userId, count } = body

  if (!query || !Array.isArray(assetIds)) {
    return c.json({ error: 'Missing required fields: query, assetIds' }, 400)
  }

  const engine = new SimpleShootEngine({
    OPENROUTER_API_KEY: c.env.OPENROUTER_API_KEY,
    FAL_KEY: c.env.FAL_KEY,
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    QDRANT_URL: c.env.QDRANT_URL,
    QDRANT_API_KEY: c.env.QDRANT_API_KEY,
    DATABASE_URL: c.env.DATABASE_URL,
    ASSETS_BUCKET: c.env.ASSETS_BUCKET,
    API_URL: c.env.API_URL,
  })

  return streamSSE(c, async (stream) => {
    const send = async (event: object) => {
      await stream.write(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    }

    try {
      let resolvedUserId = userId
      let resolvedProjectId = projectId
      if (!resolvedUserId || resolvedUserId === 'dev') {
        const ctx = await resolveDevContext(c.env.DATABASE_URL)
        resolvedUserId = ctx.userId
        resolvedProjectId = resolvedProjectId || ctx.projectId
      }
      await engine.run(
        { query, assetIds, projectId: resolvedProjectId || 'default', userId: resolvedUserId, count },
        send,
      )
    } catch (err: any) {
      await send({ type: 'error', message: err.message || 'Simple shoot engine failed' })
    } finally {
      await stream.close()
    }
  })
})

/**
 * GET /shoots/crops/:assetId
 * Lists all crops saved for a given source asset.
 * Crops are stored at crops/{userId}/{projectId}/{assetId}/*.jpg
 * Returns { crops: [{ name, url, r2Key }] }
 */
shoots.get('/crops/:assetId', async (c) => {
  const assetId = c.req.param('assetId')
  const prefix = `crops/`

  // List all R2 objects whose key contains this assetId
  const listed = await c.env.ASSETS_BUCKET.list({ prefix })
  const matching = listed.objects.filter(o => o.key.includes(`/${assetId}/`))

  const crops = matching.map(o => {
    const name = o.key.split('/').pop()?.replace(/\.[^.]+$/, '') ?? o.key
    return {
      name,
      r2Key: o.key,
      url: `/assets/download?key=${encodeURIComponent(o.key)}`,
    }
  })

  return c.json({ assetId, crops })
})

export default shoots
