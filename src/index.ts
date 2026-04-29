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
import { sessions, users, subscriptions, plans, userCredits, profiles } from './db/schema'
import { eq } from 'drizzle-orm'
import auth from './routes/auth'
import pinterest from './routes/pinterest'
import user from './routes/user'
import billing from './routes/billing'

import memory from './routes/memory'
import chat from './routes/chat'
import storytelling from './routes/storytelling'
import profile from './routes/profile'
import project from './routes/project'
import assetsRouter from './routes/assets'
import suggestions from './routes/suggestions'
import waitlist from './routes/waitlist'
import creative from './routes/creative'
import { sessionMiddleware, type AuthVariables } from './middleware/auth'
import { GlobalLimiter } from './durable-objects/GlobalLimiter'
import { ChatSession } from './durable-objects/ChatSession'
import { Responser } from './durable-objects/Responser'
import { StorytellerTool } from './services/chat/tools/StorytellerTool'

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
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
  GLOBAL_LIMITER: DurableObjectNamespace
  CHAT_SESSION: DurableObjectNamespace
  RESPONSER: DurableObjectNamespace
  CHAT_QUEUE: Queue
  LLM_QUEUE: Queue
  IMAGE_QUEUE: Queue
  VIDEO_QUEUE: Queue
  OPENAI_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings, Variables: AuthVariables }>()

// --- Middleware ---
app.use('*', async (c, next) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://www.alloreai.com',
    'https://alloreai.com',
    'https://waitlist.alloreai.com'
  ];
  
  // Also include the environment variable if set
  if (c.env.FRONTEND_URL) {
    allowedOrigins.push(c.env.FRONTEND_URL);
  }

  return cors({
    origin: (origin) => {
      if (allowedOrigins.includes(origin) || !origin) {
        return origin;
      }
      return allowedOrigins[0]; // fallback
    },
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

app.route('/memory', memory)
app.route('/chat', chat)
app.route('/billing', billing)
app.route('/storytelling', storytelling)
app.route('/profile', profile)
app.route('/projects', project)
app.route('/assets', assetsRouter)
app.route('/suggestions', suggestions)
app.route('/api', waitlist)
app.route('/creative', creative)

// --- Protected Routes ---
// --- Protected Routes ---

// ... (skipping ahead to the route)

// --- Protected Routes ---
app.get('/me', sessionMiddleware, async (c) => {
  const authUser = c.get('user')
  const db = getDb(c.env.DATABASE_URL)

  try {
    // Fetch full profile with subscription and credits
    const [fullProfile] = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      name: profiles.name,
      avatarUrl: profiles.avatarUrl,
      credits: userCredits.creditsRemaining,
      subscription: {
        status: subscriptions.status,
        planId: plans.id,
        planName: plans.name,
        expiresAt: subscriptions.currentPeriodEnd,
      }
    })
    .from(users)
    .leftJoin(profiles, eq(users.id, profiles.userId))
    .leftJoin(userCredits, eq(users.id, userCredits.userId))
    .leftJoin(subscriptions, eq(users.id, subscriptions.userId))
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(users.id, authUser.id))
    .limit(1)

    return c.json({ 
      success: true, 
      user: fullProfile || authUser 
    })
  } catch (error: any) {
    console.error('Fetch /me error:', error)
    return c.json({ error: 'Failed to fetch full profile' }, 500)
  }
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

export { GlobalLimiter, ChatSession, Responser }

// A simple in-memory rate limiter for external APIs
const rateLimiter = new Map<string, number[]>();
async function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = rateLimiter.get(key) || [];
  const filtered = bucket.filter(t => now - t < windowMs);
  
  if (filtered.length >= limit) {
    throw new Error(`Rate limit exceeded for ${key}`);
  }
  
  filtered.push(now);
  rateLimiter.set(key, filtered);
}

export default {
  fetch: app.fetch,
  
  async queue(batch: MessageBatch<any>, env: Bindings, ctx: ExecutionContext) {
    console.log(`[Queue] Processing batch of ${batch.messages.length} messages from ${batch.queue}`);

    for (const msg of batch.messages) {
      try {
        const { sessionId, userId, tool, input, memory, brandContext, history } = msg.body;
        
        let result: any = { hidden: {}, visible: [] };
        const toolCtx = { memory, brandContext, history, userId };

        // 1. Rate Limiting based on tool/API
        if (tool === 'storyteller' || tool === 'creative_studio') {
          await rateLimit('llm', 50, 60000); // 50 requests per minute
        } else if (tool === 'photoshoot_generator') {
          await rateLimit('image_gen', 15, 60000); // 15 image gens per minute
        }

        // 2. Execute Tool Logic
        console.log(`[Queue] Executing tool: ${tool} for session: ${sessionId}`);
        
        switch (tool) {
          case "storyteller":
            result = await new StorytellerTool(env).run(input, toolCtx);
            break;
            
          case "photoshoot_generator":
            const { PhotoshootGeneratorTool } = await import('./services/chat/tools/PhotoshootGeneratorTool');
            result = await new PhotoshootGeneratorTool(env).run(input, toolCtx);
            break;
            
          case "video_generator":
            // result = await new VideoGeneratorTool(env).run(input, toolCtx);
            console.log(`[Queue] Video generation logic would run here...`);
            result.visible.push({ type: "status", content: "Video generated successfully." });
            break;
            
          default:
            console.warn(`[Queue] Unknown tool: ${tool}`);
            break;
        }

        console.log(`[Queue] Tool ${tool} completed. Sending result to Responser...`);

        // 3. Send Result Back to DO Orchestrator
        try {
          const id = env.RESPONSER.idFromString(sessionId);
          const stub = env.RESPONSER.get(id);
          
          await (stub as any).handleToolResult(tool, result);
          console.log(`[Queue] Successfully updated Responser for session ${sessionId}`);
          msg.ack(); 
        } catch (doError) {
          console.error(`[Queue] Failed to communicate with DO for session ${sessionId}:`, doError);
          // If the DO is unreachable or errors out, we retry the message
          msg.retry({ delaySeconds: 5 });
        }

      } catch (err: any) {
        console.error("[Queue] Task execution error:", err.message);
        
        // If we hit a rate limit or a temporary API failure, back off and retry
        msg.retry({ delaySeconds: 10 });
      }
    }
  }
}

