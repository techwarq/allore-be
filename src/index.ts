import { Hono } from 'hono'
import { AsyncLocalStorage } from 'node:async_hooks'

// Shim for AsyncLocalStorage.enterWith() which is not implemented in Cloudflare Workers
// but is used internally by Stagehand's FlowLogger.
if (typeof (AsyncLocalStorage.prototype as any).enterWith !== 'function') {
  (AsyncLocalStorage.prototype as any).enterWith = function () {
    // No-op to prevent runtime errors in Workers environment
  }
}

import { cors } from 'hono/cors'
import { getDb } from './db'
import { users } from './db/schema'
import auth from './routes/auth'
import pinterest from './routes/pinterest'
import user from './routes/user'
import ugcAgent from './routes/ugc-agent'
import memory from './routes/memory'
import { sessionMiddleware, type AuthVariables } from './middleware/auth'

type Bindings = {
  ENV: string
  DATABASE_URL: string
  JWT_SECRET: string
  RESEND_API_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  FRONTEND_URL: string
  API_URL: string
  PINTEREST_COOKIE: string
  ASSETS_BUCKET: R2Bucket
  GEMINI_API_KEY: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings, Variables: AuthVariables }>()

// --- Middleware ---
app.use('*', async (c, next) => {
  const origin = c.env.FRONTEND_URL || 'http://localhost:3000'
  return cors({
    origin: origin,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })(c, next)
})

app.get('/', (c) => {
  return c.json({
    message: 'API running',
    branch: c.env.ENV,
    timestamp: new Date().toISOString()
  })
})

// --- Routes ---
app.route('/auth', auth)
app.route('/pinterest', pinterest)
app.use('/user/*', sessionMiddleware)
app.route('/user', user)
app.route('/ugc', ugcAgent)
app.route('/memory', memory)

// --- Protected Routes ---
app.get('/me', sessionMiddleware, (c) => {
    const user = c.get('user')
    return c.json({ user })
})

// Sample Protected Database Route: Fetch all users (Admin only example)
app.get('/users', sessionMiddleware, async (c) => {
  try {
    const user = c.get('user')
    if (user.role !== 'admin') {
      // return c.json({ error: 'Admin only' }, 403) 
      // For now, let's just let the user see it if they are logged in
    }
    
    const db = getDb(c.env.DATABASE_URL)
    const allUsers = await db.select().from(users)
    return c.json(allUsers)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

export default app

