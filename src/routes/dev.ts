import { Hono } from 'hono'
import { getDb } from '../db'
import { users, authAccounts, profiles, userCredits } from '../db/schema'
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
}

const dev = new Hono<{ Bindings: Bindings }>()

async function getOrCreateDevUser(db: ReturnType<typeof getDb>): Promise<string> {
  const [existing] = await db.select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1)
  if (existing) return existing.id

  const [newUser] = await db.insert(users).values({ email: DEV_EMAIL, emailVerified: true }).returning()
  await db.insert(authAccounts).values({ userId: newUser.id, provider: 'local', passwordHash: 'dev' })
  await db.insert(profiles).values({ userId: newUser.id, name: 'Dev User' })
  await db.insert(userCredits).values({ userId: newUser.id, creditsRemaining: 9999 })
  return newUser.id
}

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
  const projectId = (formData['projectId'] as string) || 'default'

  try {
    const db = getDb(c.env.DATABASE_URL)
    const userId = await getOrCreateDevUser(db)
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
