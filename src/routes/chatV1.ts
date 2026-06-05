import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getDb } from '../db'
import { BillingService } from '../services/billing.service'
import { ChatService } from '../services/chat.service'
import { sessionMiddleware } from '../middleware/auth'
import { profiles } from '../db/schema'
import { eq } from 'drizzle-orm'


const chat = new Hono<{ 
  Bindings: { 
    DATABASE_URL: string, 
    GEMINI_API_KEY: string,
    QDRANT_URL: string,
    QDRANT_API_KEY: string,
    GLOBAL_LIMITER: any,
    CHAT_SESSION: any,
    RESPONSER: any,
    CHAT_QUEUE: any,
    DODO_PAYMENTS_API_KEY: string,
    ENV: string,
    VERTEX_PROJECT_ID: string,
    VERTEX_LOCATION: string,
    VERTEX_SERVICE_ACCOUNT_EMAIL: string,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string
  },
  Variables: {
    user: any
  }
}>()


chat.post('/', sessionMiddleware, async (c) => {
    const user = c.get('user')
    const body = await c.req.json()
    const  { message , projectId , sessionId, attachments} = body

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


  } catch (error) {
    
  }


})

export default chat