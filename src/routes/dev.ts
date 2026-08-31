import { Hono } from 'hono'
import { getDb } from '../db'
import { users, authAccounts, profiles, userCredits, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { AssetUploadService } from '../services/assetUpload.service'
import { SimpleShootEngine } from '../services/shoots/SimpleShootEngine'
import { getSignedR2Url } from '../lib/r2'

const DEV_EMAIL = 'dev@alloreai.com'

type Bindings = {
  DATABASE_URL: string
  ASSETS_BUCKET: R2Bucket
  GEMINI_API_KEY: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string
  OPENROUTER_API_KEY: string
  FAL_KEY: string
  API_URL?: string
  RESPONSER: DurableObjectNamespace
}

const dev = new Hono<{ Bindings: Bindings }>()

async function getOrCreateDevContext(db: ReturnType<typeof getDb>): Promise<{ userId: string; projectId: string }> {
  // Get or create dev user
  let userId: string
  const [existing] = await db.select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1)
  if (existing) {
    userId = existing.id
  } else {
    const [newUser] = await db.insert(users).values({ email: DEV_EMAIL, emailVerified: true }).returning()
    await db.insert(authAccounts).values({ userId: newUser.id, provider: 'local', passwordHash: 'dev' })
    await db.insert(profiles).values({ userId: newUser.id, name: 'Dev User' })
    await db.insert(userCredits).values({ userId: newUser.id, creditsRemaining: 9999 })
    userId = newUser.id
  }

  // Get or create dev project for this user
  const [existingProject] = await db.select().from(projects).where(eq(projects.userId, userId)).limit(1)
  if (existingProject) return { userId, projectId: existingProject.id }

  const [newProject] = await db.insert(projects).values({ userId, title: 'Dev Project', type: 'shoots', status: 'active' }).returning()
  return { userId, projectId: newProject.id }
}

/**
 * POST /dev/reset-shoot-state
 * Auth-free debug utility — clears the shoot-flow flags (shootEngineQueued,
 * shootConfirmed) for a given project+user's chat session. Escape hatch for
 * sessions that got stuck before the reset-on-completion fix existed.
 * Body: { projectId, userId, sessionId? }
 */
dev.post('/reset-shoot-state', async (c) => {
  const body = await c.req.json()
  const { projectId, userId, sessionId } = body
  if (!projectId || !userId) {
    return c.json({ error: 'projectId and userId are required' }, 400)
  }
  const sid = sessionId || `${projectId}-${userId}`
  const id = c.env.RESPONSER.idFromName(sid)
  const stub = c.env.RESPONSER.get(id) as any
  await stub.resetShootState()
  return c.json({ success: true, sessionId: sid })
})

/**
 * POST /dev/upload
 * Auth-free upload endpoint for testing. Creates a stable dev user automatically.
 * Form fields: file (required), type, subtype, projectId
 */
dev.post('/upload', async (c) => {
  const formData = await c.req.parseBody()

  const file = formData['file']
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Valid file is required' }, 400)
  }

  const type = (formData['type'] as string) || 'image'
  const subtype = (formData['subtype'] as string) || 'product_image'

  try {
    const db = getDb(c.env.DATABASE_URL)
    const { userId, projectId } = await getOrCreateDevContext(db)
    const uploadService = new AssetUploadService(c.env, db)

    const asset = await uploadService.processUpload({ userId, projectId, file, type, subtype })

    const apiUrl = c.env.API_URL || 'https://allore-be.workers.dev'
    return c.json({
      success: true,
      assetId: asset.id,
      userId,
      url: `${apiUrl}/assets/download?key=${encodeURIComponent(asset.url)}`,
      tags: asset.tags,
      colors: asset.colors,
      name: (asset.parsedData as any)?.name || null,
      description: (asset.parsedData as any)?.description || null,
    })
  } catch (err: any) {
    console.error('[dev/upload]', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

/**
 * POST /dev/simple-shoot
 * Auth-free harness to run SimpleShootEngine directly, bypassing the whole
 * chat/vibe-picker gate flow — the fast way to A/B the style-anchor spike:
 * call it once with `vibeImageUrl` and once without, same product, and compare
 * the returned image URLs.
 * Body: { assetIds: string[], query?: string, count?: number, vibeImageUrl?: string, modelR2Keys?: string[] }
 */
dev.post('/simple-shoot', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { assetIds, query, count, vibeImageUrl, modelR2Keys } = body
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    return c.json({ error: 'assetIds (non-empty array) is required' }, 400)
  }

  const db = getDb(c.env.DATABASE_URL)
  const { userId, projectId } = await getOrCreateDevContext(db)

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

  // Collect every streamed event so the response is a full trace — you can see
  // the creative direction, the compiled prompts (with/without the anchor
  // clause), and the final shot URLs in one JSON blob.
  const events: object[] = []
  const stream = async (event: object) => { events.push(event) }

  try {
    const shots = await engine.run(
      { query: query || 'Professional product photoshoot', assetIds, projectId, userId, count: count ?? 1, modelR2Keys, vibeImageUrl },
      stream
    )
    return c.json({ success: true, anchorUsed: !!vibeImageUrl, shots, events })
  } catch (err: any) {
    console.error('[dev/simple-shoot]', err)
    return c.json({ error: err.message || 'Shoot failed', events }, 500)
  }
})

/**
 * POST /dev/style-images/upload
 * Auth-free R2 upload for scripts/pinterest-style-curator.ts — that script
 * runs as a standalone Node process (not inside the Worker), so it has no
 * direct ASSETS_BUCKET binding. It routes the actual write through this
 * endpoint instead. Stores under styleimages/<style_id>/<reference_id>.<ext>.
 * Form fields: file (required), key (required R2 key)
 */
dev.post('/style-images/upload', async (c) => {
  const formData = await c.req.parseBody()
  const file = formData['file']
  const key = formData['key'] as string

  if (!file || !(file instanceof File)) return c.json({ error: 'Valid file is required' }, 400)
  if (!key || !key.startsWith('styleimages/')) return c.json({ error: 'key is required and must start with "styleimages/"' }, 400)

  try {
    const buffer = await file.arrayBuffer()
    await c.env.ASSETS_BUCKET.put(key, buffer, { httpMetadata: { contentType: file.type || 'image/jpeg' } })
    const signedUrl = await signUrlOrFallback(c, key, 60 * 60 * 24 * 7) // 7 days
    return c.json({ success: true, key, signedUrl })
  } catch (err: any) {
    console.error('[dev/style-images/upload]', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

/**
 * GET /dev/style-images/signed-url?key=...
 * Signed URLs expire — retrieval-time callers (e.g. StyleMemoryService) hit
 * this to mint a fresh one for a stored R2 key rather than relying on a
 * cached URL going stale.
 */
dev.get('/style-images/signed-url', async (c) => {
  const key = c.req.query('key')
  if (!key) return c.json({ error: 'key is required' }, 400)

  try {
    const signedUrl = await signUrlOrFallback(c, key, 60 * 60) // 1 hour
    return c.json({ success: true, key, signedUrl })
  } catch (err: any) {
    console.error('[dev/style-images/signed-url]', err)
    return c.json({ error: err.message || 'Failed to sign URL' }, 500)
  }
})

// bucket.createSignedUrl() only works against real R2 in production — local
// `wrangler dev`'s R2 emulation doesn't implement it ("createSignedUrl is
// not a function"). Same fallback other tools in this repo already use
// (AvatarGeneratorTool, SimpleShootEngine, etc.): drop back to the existing
// public /assets/download proxy route, which just streams the object
// straight from R2 with no signing involved.
async function signUrlOrFallback(c: any, key: string, expiresIn: number): Promise<string> {
  try {
    return await getSignedR2Url(c.env.ASSETS_BUCKET as any, key, expiresIn)
  } catch (err: any) {
    console.warn('[dev/style-images] getSignedR2Url failed, falling back to /assets/download proxy:', err.message)
    const apiUrl = c.env.API_URL || 'http://localhost:8787'
    return `${apiUrl}/assets/download?key=${encodeURIComponent(key)}`
  }
}

export default dev
