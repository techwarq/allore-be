import { Hono } from 'hono'
import { StorytellingEngineService } from '../services/storytellingEngine.service'

type Bindings = {
  GEMINI_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
}

const storytelling = new Hono<{ Bindings: Bindings }>()

/**
 * Endpoint to ingest branding content into the storytelling engine.
 * Supports both single object and array of objects.
 * POST /storytelling/ingest
 */
storytelling.post('/ingest', async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.log(`[Route] Ingest Request Started: ${requestId}`);
  console.time(`[Request] ${requestId}`);
  
  try {
    const body = await c.req.json()
    
    const service = new StorytellingEngineService(
      c.env.GEMINI_API_KEY,
      c.env.VERTEX_PROJECT_ID,
      c.env.VERTEX_LOCATION,
      c.env.QDRANT_URL,
      c.env.QDRANT_API_KEY
    )

    // Ensure collection exists (lazy init)
    await service.initializeCollection()

    if (Array.isArray(body)) {
      console.log(`[Route] Detected batch ingestion for ${body.length} items`);
      const results = await service.batchIngest(body);
      return c.json({
        success: true,
        requestId,
        results,
        message: 'Batch ingestion completed'
      })
    } else {
      const { text, metadata } = body
      if (!text) {
        return c.json({ error: 'Text content is required' }, 400)
      }

      const id = await service.ingest(text, {
        type: metadata?.type || 'general',
        tags: metadata?.tags || [],
        use_case: metadata?.use_case || [],
        strength: metadata?.strength || 'medium',
        source: metadata?.source || 'unknown'
      })

      return c.json({
        success: true,
        id,
        requestId,
        message: 'Content ingested successfully into storytelling_engine'
      })
    }
  } catch (error: any) {
    console.error('[Storytelling Route] Ingestion error:', error)
    return c.json({ error: error.message || 'Internal Server Error' }, 500)
  } finally {
    console.timeEnd(`[Request] ${requestId}`);
  }
})

/**
 * Endpoint to perform semantic search on storytelling data.
 * POST /storytelling/search
 */
storytelling.post('/search', async (c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.log(`[Route] Search Request Started: ${requestId}`);
  
  try {
    const body = await c.req.json()
    const { query, limit } = body

    if (!query) {
      return c.json({ error: 'Search query is required' }, 400)
    }

    const service = new StorytellingEngineService(
      c.env.GEMINI_API_KEY,
      c.env.VERTEX_PROJECT_ID,
      c.env.VERTEX_LOCATION,
      c.env.QDRANT_URL,
      c.env.QDRANT_API_KEY
    )

    const results = await service.search(query, limit || 5)

    return c.json({
      success: true,
      requestId,
      results
    })
  } catch (error: any) {
    console.error('[Storytelling Route] Search error:', error)
    return c.json({ error: error.message || 'Internal Server Error' }, 500)
  }
})

export default storytelling
