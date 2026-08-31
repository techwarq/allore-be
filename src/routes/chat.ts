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

/**
 * Handle streaming chat with protection, billing, and advanced context (VPS-BE pattern).
 */
chat.post('/', sessionMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const { message, projectId, attachments, model: requestedModel } = body

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
      GEMINI_API_KEY: c.env.GEMINI_API_KEY,
      VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
      VERTEX_LOCATION: c.env.VERTEX_LOCATION,
      VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    })

    // 2. Billing & Plan Check
    const access = await billing.validateAccess(user.id)
    if (!access.allowed) {
      await limiter.decrement()
      return c.json({ error: access.error }, 403)
    }

    // 3. Connect to Responser DO
    // Deterministic per project+user — deliberately ignores any client-supplied
    // `sessionId` here. Session state (avatar choice, shoot brief, vibe pick,
    // answered gates) lives ONLY in this DO's storage, not the DB. If the
    // client ever sent an inconsistent or freshly-generated id across "chats"
    // for the same project, this would silently spin up a brand-new DO with
    // empty campaign state on every reconnect — the product itself would still
    // get re-detected via loadProjectHistory's DB fallback, but everything
    // else would look "forgotten" and re-ask questions already answered.
    // Pinning this to project+user guarantees the same DO every time,
    // regardless of what the client does or doesn't track client-side.
    const sid = `${projectId}-${user.id}`
    const responserId = c.env.RESPONSER.idFromName(sid)
    const responser = c.env.RESPONSER.get(responserId)
    
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id)).limit(1);
    const brandContext = profile ? {
      companyName: profile.companyName,
      industry: profile.industry,
      extraDetails: profile.extraDetails,
      goals: profile.goals,
      targetAudience: profile.targetAudience,
      userType: profile.userType, 
      preferences: (profile.preferences as any)?.company || {}
    } : {};

    // setContext is now idempotent and handles history loading internally
    await responser.setContext(brandContext, user.id, projectId, sid);

    const releaseLimiter = () => limiter.decrement().catch(console.error);

    // 4. Stream Response
    return streamSSE(c, async (stream) => {
      let totalTokens = 0;
      let finalModel = requestedModel || 'gemini-flash';
      let streamSuccess = false;

      try {
        const TIMEOUT_MS = 120_000;
        const readable: ReadableStream = await Promise.race([
          responser.process(message, attachments || []),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Response timeout')), TIMEOUT_MS)
          )
        ]);
        
        const reader = readable.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          await stream.write(value);
          
          const text = decoder.decode(value, { stream: true });
          const match = text.match(/"type":"done".*?"tokens":(\d+)/);
          if (match) totalTokens = parseInt(match[1], 10);
        }

        streamSuccess = true;

      } catch (err: any) {
        console.error("Chat Stream Error:", err);
        const errPayload = `data: ${JSON.stringify({ type: 'error', message: err.message || 'Stream failed' })}\n\n`;
        await stream.write(new TextEncoder().encode(errPayload));
      } finally {
        if (streamSuccess && totalTokens > 0) {
          const cost = ai.estimateCost(totalTokens, finalModel);
          await billing.recordUsage(user.id, totalTokens, cost).catch(console.error);
          
          if (c.env.CHAT_QUEUE) {
            await c.env.CHAT_QUEUE.send({
              userId: user.id,
              tokens: totalTokens,
              cost,
              model: finalModel,
              timestamp: new Date().toISOString()
            }).catch(console.error);
          }
        }
        releaseLimiter();
        await stream.close();
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
  const responserId = c.env.RESPONSER.idFromName(sessionId)
  const responser = c.env.RESPONSER.get(responserId)
  const result = await responser.cancel()
  return c.json(result)
})

/**
 * Poll for async job results.
 */
chat.get('/jobs/:sessionId/:jobId', sessionMiddleware, async (c) => {
  const sessionId = c.req.param('sessionId');
  const jobId = c.req.param('jobId');

  try {
    const responserId = c.env.RESPONSER.idFromName(sessionId);
    const responser = c.env.RESPONSER.get(responserId);
    
    const result = await (responser as any).pollJobResult(jobId);
    return c.json(result);
  } catch (error: any) {
    console.error("Poll Job Error:", error);
    return c.json({ error: 'Failed to poll job status.' }, 500);
  }
});

export default chat
