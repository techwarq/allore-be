import { Hono } from 'hono'
import { PinterestBrowserService } from '../services/pinterest-browser.service'
import { PinterestService } from '../services/pinterest.service'
import { sessionMiddleware, type AuthVariables } from '../middleware/auth'
import { getDb } from '../db'

const pinterest = new Hono<{ 
  Bindings: { 
    PINTEREST_COOKIE: string,
    DATABASE_URL: string,
    ASSETS_BUCKET: R2Bucket,
    BROWSERBASE_API_KEY: string,
    BROWSERBASE_PROJECT_ID: string,
    GEMINI_API_KEY: string,
    STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL"
  },
  Variables: AuthVariables 
}>()

/**
 * POST /search
 * Payload: { "q": "search term", "limit": 20, "analyze": true }
 */
pinterest.post('/search', async (c) => {
  const body = await c.req.json()
  const query = body.q
  const limit = parseInt(body.limit || '5', 10)
  const analyze = body.analyze === true

  if (!query) {
    return c.json({ error: 'Missing search query (q) in payload' }, 400)
  }

  const browserService = new PinterestBrowserService(
    c.env.GEMINI_API_KEY,
    c.env.BROWSERBASE_API_KEY,
    c.env.BROWSERBASE_PROJECT_ID,
    c.env.STAGEHAND_ENV
  )

  try {
    await browserService.init()
    const pins = await browserService.searchPinterest(query, limit, analyze)
    await browserService.close()
    
    return c.json({ results: pins, count: pins.length })
  } catch (error: any) {
    console.error('❌ Pinterest Browser Search Error:', error)
    // Ensure browser is closed even on error
    try { await browserService.close() } catch (e) {}
    
    return c.json({ error: 'Failed to fetch results from Pinterest Browser.', details: error.message }, 500)
  }
})

/**
 * POST /save
 * Payload: { "url": "https://...", "metadata": { ... } }
 */
pinterest.post('/save', async (c) => {
  // Use a placeholder ID for testing since we're bypassing auth
  const TEST_USER_ID = '00000000-0000-0000-0000-000000000000'
  const { url, metadata } = await c.req.json()

  if (!url) return c.json({ error: 'Missing image url' }, 400)

  try {
    const db = getDb(c.env.DATABASE_URL)
    
    try {
      // First attempt: Direct fetch (fast)
      const asset = await PinterestService.saveToR2(
        db,
        c.env.ASSETS_BUCKET as any,
        TEST_USER_ID,
        url,
        metadata
      )
      return c.json({ message: 'Asset saved successfully', asset }, 201)
    } catch (saveError: any) {
      if (saveError.message === "FORBIDDEN_DIRECT_FETCH") {
        console.log("🛡️ Direct fetch blocked. Falling back to Browser-based fetch...");
        
        const browserService = new PinterestBrowserService(
          c.env.GEMINI_API_KEY,
          c.env.BROWSERBASE_API_KEY,
          c.env.BROWSERBASE_PROJECT_ID,
          c.env.STAGEHAND_ENV
        )
        
        try {
          const { data, contentType } = await browserService.fetchImage(url);
          const asset = await PinterestService.saveToR2(
            db,
            c.env.ASSETS_BUCKET as any,
            TEST_USER_ID,
            url,
            metadata,
            data,
            contentType
          )
          return c.json({ message: 'Asset saved successfully (via browser fallback)', asset }, 201)
        } finally {
          await browserService.close();
        }
      }
      throw saveError;
    }
  } catch (error: any) {
    console.error('❌ Pinterest Save Error:', error)
    return c.json({ error: 'Failed to save asset to R2.', details: error.message }, 500)
  }
})

export default pinterest
