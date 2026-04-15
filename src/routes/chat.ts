import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getDb } from '../db'
import { BillingService } from '../services/billing.service'
import { ChatService } from '../services/chat.service'
import { sessionMiddleware } from '../middleware/auth'

const chat = new Hono<{ 
  Bindings: { 
    DATABASE_URL: string, 
    GEMINI_API_KEY: string,
    QDRANT_URL: string,
    QDRANT_API_KEY: string,
    GLOBAL_LIMITER: any,
    CHAT_SESSION: any,
    CHAT_QUEUE: any,
    DODO_PAYMENTS_API_KEY: string,
    ENV: string
  },
  Variables: {
    user: any
  }
}>()

/**
 * Handle streaming chat with protection, billing, and advanced context (VPS-BE pattern).
 */
chat.post('/', sessionMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const { message, projectId, sessionId, model: requestedModel } = body

  if (!message || !projectId) {
    return c.json({ error: 'Missing message or projectId.' }, 400)
  }

  // 1. Global Rate Limit Check
  const limiterId = c.env.GLOBAL_LIMITER.idFromName('global')
  const limiter = c.env.GLOBAL_LIMITER.get(limiterId)
  const limiterStatus: any = await limiter.checkAndIncrement()
  
  if (!limiterStatus.allowed) {
    return c.json({ error: 'Server capacity reached.' }, 429)
  }

  try {
    const db = getDb(c.env.DATABASE_URL)
    const billing = new BillingService(db, c.env)
    const ai = new ChatService({
      DB: db,
      QDRANT_URL: c.env.QDRANT_URL,
      QDRANT_API_KEY: c.env.QDRANT_API_KEY,
      GEMINI_API_KEY: c.env.GEMINI_API_KEY
    })

    // 2. Billing & Plan Check
    const access = await billing.validateAccess(user.id)
    if (!access.allowed) {
      await limiter.decrement()
      return c.json({ error: access.error }, 403)
    }

    // 3. Session Lock
    const sid = sessionId || `user-${user.id}`
    const sessionObjectId = c.env.CHAT_SESSION.idFromName(sid)
    const chatSession = c.env.CHAT_SESSION.get(sessionObjectId)
    const rayId = c.req.header('cf-ray') || Math.random().toString(36)
    
    const lockResult: any = await chatSession.lock(rayId)
    if (!lockResult.success) {
      await limiter.decrement()
      return c.json({ error: lockResult.message }, 429)
    }

    // 4. Stream Response
    return streamSSE(c, async (stream) => {
      let totalContent = ""
      let finalModel = requestedModel || ai.getModelForBudget(access.credits || 0)

      try {
        const generator = ai.processMessage({
          projectId,
          userId: user.id,
          message,
          sessionId: sid
        })

        for await (const event of generator as any) {
          // Handle specific event types
          if (event.type === 'delta' && event.text) {
            totalContent += event.text
          }

          // Forward event to client
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: 'message'
          })

          if (event.type === 'error' && event.message) throw new Error(event.message)
        }

        // 5. Usage Tracking
        const tokens = ai.estimateTokens(totalContent)
        const cost = ai.estimateCost(tokens, finalModel)

        if (c.env.CHAT_QUEUE) {
          await c.env.CHAT_QUEUE.send({
            userId: user.id,
            tokens,
            cost,
            model: finalModel,
            timestamp: new Date().toISOString()
          })
        }

        await billing.recordUsage(user.id, tokens, cost)

        await stream.writeSSE({
          data: JSON.stringify({ type: 'done', tokens, cost }),
          event: 'message'
        })

      } catch (err: any) {
        console.error("Chat Stream Error:", err)
        await stream.writeSSE({
          data: JSON.stringify({ type: 'error', message: err.message || 'Stream failed' }),
          event: 'error'
        })
      } finally {
        await chatSession.unlock(rayId)
        await limiter.decrement()
        await stream.close()
      }
    })

  } catch (error: any) {
    console.error("Chat Setup Error:", error)
    await limiter.decrement()
    return c.json({ error: 'Failed to initialize session.' }, 500)
  }
})

/**
 * Cancel an active session.
 */
chat.post('/:id/cancel', sessionMiddleware, async (c) => {
  const sessionId = c.req.param('id')
  const sessionObjectId = c.env.CHAT_SESSION.idFromName(sessionId)
  const chatSession = c.env.CHAT_SESSION.get(sessionObjectId)
  const result = await chatSession.cancel()
  return c.json(result)
})

export default chat
