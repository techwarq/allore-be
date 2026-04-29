import { Hono } from 'hono'
import { getDb } from '../db'
import { ProfileService } from '../services/profile.service'
import { sessionMiddleware, type AuthVariables } from '../middleware/auth'
import { MemoryServiceV2 } from '../services/memory-v2.service'

type Bindings = {
  DATABASE_URL: string
  ASSETS_BUCKET: R2Bucket
  GEMINI_API_KEY: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
  VERTEX_PROJECT_ID: string
  VERTEX_LOCATION: string
  VERTEX_SERVICE_ACCOUNT_EMAIL: string
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: string
}

const profile = new Hono<{ Bindings: Bindings, Variables: AuthVariables }>()
const GLOBAL_PROJECT_ID = '00000000-0000-0000-0000-000000000000'

// Ensure all profile routes are protected by session
profile.use('*', sessionMiddleware)

/**
 * GET /profile
 * Fetch the current user's profile.
 */
profile.get('/', async (c) => {
  const user = c.get('user')
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProfileService(db)

  try {
    const data = await service.getProfile(user.id)
    if (!data) {
      return c.json({ error: 'Profile not found' }, 404)
    }
    return c.json({ success: true, profile: data })
  } catch (error: any) {
    console.error('[Profile Route] GET failed:', error)
    return c.json({ error: 'Failed to fetch profile' }, 500)
  }
})

/**
 * POST /profile
 * Upsert (Create/Update) the profile with onboarding data.
 */
profile.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProfileService(db)
  const memoryV2 = new MemoryServiceV2({
    DB: db,
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    QDRANT_URL: c.env.QDRANT_URL,
    QDRANT_API_KEY: c.env.QDRANT_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
  })

  try {
    const updated = await service.upsertProfile(user.id, body)
    
    // Trigger Relational Memory Ingestion (Non-blocking and safe)
    c.executionCtx.waitUntil((async () => {
      try {
        console.log(`[Profile Route] Ingesting updated profile into Memory V2 for user: ${user.id}`);
        await memoryV2.initialize();
        await memoryV2.ingest(user.id, GLOBAL_PROJECT_ID, 'profile', updated);
      } catch (err) {
        console.error('[Profile Route] Memory ingestion failed:', err);
      }
    })());

    return c.json({ success: true, profile: updated, message: 'Profile saved successfully' })
  } catch (error: any) {
    console.error('[Profile Route] POST failed:', error)
    return c.json({ error: 'Failed to save profile' }, 500)
  }
})

/**
 * PUT /profile
 * Partial update of the profile.
 */
profile.put('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProfileService(db)
  const memoryV2 = new MemoryServiceV2({
    DB: db,
    GEMINI_API_KEY: c.env.GEMINI_API_KEY,
    QDRANT_URL: c.env.QDRANT_URL,
    QDRANT_API_KEY: c.env.QDRANT_API_KEY,
    VERTEX_PROJECT_ID: c.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: c.env.VERTEX_LOCATION,
    VERTEX_SERVICE_ACCOUNT_EMAIL: c.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
    VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY: c.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
  })

  try {
    const updated = await service.upsertProfile(user.id, body)
    
    // Update Memory V2 (Non-blocking and safe)
    c.executionCtx.waitUntil((async () => {
      try {
        await memoryV2.initialize();
        await memoryV2.ingest(user.id, GLOBAL_PROJECT_ID, 'profile', updated);
      } catch (err) {
        console.error('[Profile Route] Memory update failed:', err);
      }
    })());

    return c.json({ success: true, profile: updated, message: 'Profile updated successfully' })
  } catch (error: any) {
    console.error('[Profile Route] PUT failed:', error)
    return c.json({ error: 'Failed to update profile' }, 500)
  }
})


/**
 * DELETE /profile
 * Resets the profile data.
 */
profile.delete('/', async (c) => {
  const user = c.get('user')
  const db = getDb(c.env.DATABASE_URL)
  const service = new ProfileService(db)

  try {
    await service.resetProfile(user.id)
    return c.json({ success: true, message: 'Profile reset successfully' })
  } catch (error: any) {
    console.error('[Profile Route] DELETE failed:', error)
    return c.json({ error: 'Failed to reset profile' }, 500)
  }
})

/**
 * POST /profile/upload
 * Handles asset uploads for the branding kit.
 */
profile.post('/upload', async (c) => {
  const user = c.get('user')
  const formData = await c.req.parseBody()
  const file = formData['file']

  if (!(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  try {
    const fileName = `profiles/${user.id}/branding-kit/${Date.now()}-${file.name}`
    await c.env.ASSETS_BUCKET.put(fileName, file.stream(), {
      httpMetadata: { contentType: file.type }
    })

    // In a real staging environment, we'd return a public URL or signed URL
    // For now, returning the path in the bucket
    return c.json({ 
      success: true, 
      url: fileName, 
      message: 'Branding kit uploaded successfully' 
    })
  } catch (error: any) {
    console.error('[Profile Route] Upload failed:', error)
    return c.json({ error: 'Failed to upload asset' }, 500)
  }
})

export default profile
