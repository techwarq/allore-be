import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sessionMiddleware } from '../middleware/auth'
import { ShootEngine } from '../services/shoots/ShootEngine'

type ShootsBindings = {
  DATABASE_URL: string
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string
  ASSETS_BUCKET: R2Bucket
}

const shoots = new Hono<{ Bindings: ShootsBindings, Variables: { user: any } }>()

/**
 * POST /shoots/generate
 * Streams a full photoshoot generation pipeline via SSE.
 * Body: { intent: string, assetIds: string[], projectId: string }
 */
shoots.post('/generate', sessionMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const { intent, assetIds, projectId } = body

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
      await engine.run({ intent, assetIds, projectId: projectId || 'default', userId: user.id }, send)
    } catch (err: any) {
      await send({ type: 'error', message: err.message || 'Shoot engine failed' })
    } finally {
      await stream.close()
    }
  })
})

export default shoots
