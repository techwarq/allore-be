import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ShootEngine } from '../services/shoots/ShootEngine'
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
  ASSETS_BUCKET: R2Bucket
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
  const { intent, assetIds, projectId, userId } = body

  if (!intent || !Array.isArray(assetIds) || assetIds.length === 0) {
    return c.json({ error: 'Missing required fields: intent, assetIds' }, 400)
  }

  const engine = new ShootEngine({
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY,
    DATABASE_URL: c.env.DATABASE_URL,
    ASSETS_BUCKET: c.env.ASSETS_BUCKET,
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
      await engine.run({ intent, assetIds, projectId: resolvedProjectId || 'default', userId: resolvedUserId }, send)
    } catch (err: any) {
      await send({ type: 'error', message: err.message || 'Shoot engine failed' })
    } finally {
      await stream.close()
    }
  })
})

export default shoots
