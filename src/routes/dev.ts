import { Hono } from 'hono'
import { getDb } from '../db'
import { users, authAccounts, profiles, userCredits, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { AssetUploadService } from '../services/assetUpload.service'

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

export default dev
