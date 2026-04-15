import { Hono } from 'hono'
import { getDb } from '../db'
import { users, profiles } from '../db/schema'
import { eq, sql } from 'drizzle-orm'
import { CompanyResearch } from '../services/company-research.service'
import { MemoryService } from '../services/memory.service'

type Bindings = {
  DATABASE_URL: string
  QDRANT_URL: string
  QDRANT_API_KEY: string
  GEMINI_API_KEY: string
  BROWSERBASE_API_KEY: string
}

const user = new Hono<{ Bindings: Bindings }>()

// ==========================================
// 🧑 User Profile (Base Table)
// ==========================================

export const getUserProfile = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const db = getDb(c.env.DATABASE_URL)

    const [profile] = await db.select().from(users).where(eq(users.id, userId)).limit(1)

    if (!profile) {
      return c.json({ error: 'Profile not found' }, 404)
    }

    // User profile (safe fields)
    const safeProfile = profile

    return c.json({ success: true, profile: safeProfile })
  } catch (error) {
    console.error('getUserProfile error:', error)
    return c.json({ error: 'Failed to get profile' }, 500)
  }
}

export const updateUserProfile = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const updates = await c.req.json()
    const db = getDb(c.env.DATABASE_URL)

    // Example fields to update safely: name
    if (updates.name) {
      await db.update(profiles).set({ 
        name: updates.name,
        updatedAt: new Date()
      }).where(eq(profiles.userId, userId))
    }

    return c.json({ success: true, message: 'Profile updated successfully' })
  } catch (error) {
    console.error('updateUserProfile error:', error)
    return c.json({ error: 'Failed to update profile' }, 500)
  }
}

// ==========================================
// 🎨 User Preferences
// ==========================================

export const getUserPreferences = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const db = getDb(c.env.DATABASE_URL)

    const [profile] = await db.select({ preferences: profiles.preferences }).from(profiles).where(eq(profiles.userId, userId)).limit(1)

    return c.json({ success: true, preferences: (profile?.preferences as any)?.personal || {} })
  } catch (error) {
    console.error('getUserPreferences error:', error)
    return c.json({ error: 'Failed to get preferences' }, 500)
  }
}

export const updateUserPreferences = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const updates = await c.req.json()
    const db = getDb(c.env.DATABASE_URL)

    // Merge into profiles.preferences.personal
    await db.update(profiles)
      .set({
        preferences: sql`jsonb_set(
          COALESCE(${profiles.preferences}, '{}'::jsonb), 
          '{personal}', 
          COALESCE(${profiles.preferences}->'personal', '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb
        )`,
        updatedAt: new Date()
      })
      .where(eq(profiles.userId, userId))

    // 2. Trigger background research safely
    const urlsToResearch: { label: string; url: string }[] = []
    
    if (updates.competitors && Array.isArray(updates.competitors)) {
      updates.competitors.forEach((url: string) => {
          if (url && url.startsWith('http')) {
              urlsToResearch.push({ label: 'Competitor', url })
          }
      })
    }

    if (updates.resources && Array.isArray(updates.resources)) {
      updates.resources.forEach((url: string) => {
          if (url && url.startsWith('http')) {
              urlsToResearch.push({ label: 'Resource', url })
          }
      })
    }

    if (urlsToResearch.length > 0) {
      c.executionCtx.waitUntil((async () => {
        try {
          console.log(`🔍 Starting background research for user ${userId} with ${urlsToResearch.length} URLs`)
          const researcher = new CompanyResearch(c.env.GEMINI_API_KEY, c.env.BROWSERBASE_API_KEY)
          await researcher.init()
          
          let collectiveSummary = ''
          let collectiveImages: any[] = []

          for (const item of urlsToResearch) {
             const results = await researcher.companyUrlResearch(item.url, "Extract key style combinations, specific design aesthetics, color combinations, and high-quality image inspirations.")
             if (results.researchSummary) collectiveSummary += results.researchSummary + '\n'
             if (results.imageAnalysis) collectiveImages = collectiveImages.concat(results.imageAnalysis)
          }

          console.log(`✅ Research completed for user ${userId}`)
          
          await getDb(c.env.DATABASE_URL).update(profiles).set({
             preferences: sql`jsonb_set(
               ${profiles.preferences}, 
               '{personal,researchResults}', 
               ${JSON.stringify({
                   summary: collectiveSummary,
                   images: collectiveImages,
                   lastUpdated: new Date()
               })}::jsonb
             )`
          }).where(eq(profiles.userId, userId))

          await researcher.close()
        } catch (error) {
          console.error(`❌ Background research failed for user ${userId}:`, error)
        }
      })())
    }

    // 3. Sync to Vector Memory (Qdrant)
    c.executionCtx.waitUntil((async () => {
      try {
        if (!c.env.QDRANT_URL) {
          console.warn('QDRANT_URL not configured. Skipping memory sync.')
          return
        }
        
        const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY)
        const fullPrefs = { ...updates, userId }
        const prefText = `User Preferences: ${JSON.stringify(fullPrefs)}`

        // Fake vector generation or connect to your actual embedding logic here.
        // For now, Qdrant requires exactly 768 dimensions per the schema created
        // We will generate a blank/zero vector just to store the payload unless you have an embedding provider handy.
        // Wait, the real app probably uses vertexai or gemini embedding API.
        // Replacing with a placeholder warning log.
        console.warn('Memory Sync requires a 768 length array from an embedding model to use addMemory. Ensure you pass Google Gemini/Vertex embedding result here.');

        // Example schema structure insertion map (We'd use an array of 768 random/zeroes mapping if we merely want metadata, but that defeats semantic search)
        // await memoryService.addMemory('user_info', crypto.randomUUID(), new Array(768).fill(0), {
        //   userId: String(userId),
        //   text: prefText,
        //   createdAt: new Date().toISOString()
        // });
      } catch (memErr) {
        console.error('Failed to sync user preferences to vector DB:', memErr)
      }
    })())

    return c.json({ success: true, message: 'Preferences updated successfully' })
  } catch (error) {
    console.error('updateUserPreferences error:', error)
    return c.json({ error: 'Failed to update preferences' }, 500)
  }
}

// ==========================================
// 🏢 Company Preferences
// ==========================================

export const getCompanyPreferences = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const db = getDb(c.env.DATABASE_URL)

    const [profile] = await db.select({ preferences: profiles.preferences }).from(profiles).where(eq(profiles.userId, userId)).limit(1)

    return c.json({ success: true, preferences: (profile?.preferences as any)?.company || {} })
  } catch (error) {
    console.error('getCompanyPreferences error:', error)
    return c.json({ error: 'Failed to get company preferences' }, 500)
  }
}

export const updateCompanyPreferences = async (c: any) => {
  try {
    const userId = c.req.param('userId')
    const updates = await c.req.json()
    const db = getDb(c.env.DATABASE_URL)

    // Merge into profiles.preferences.company
    await db.update(profiles)
      .set({
        preferences: sql`jsonb_set(
          COALESCE(${profiles.preferences}, '{}'::jsonb), 
          '{company}', 
          COALESCE(${profiles.preferences}->'company', '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb
        )`,
        updatedAt: new Date()
      })
      .where(eq(profiles.userId, userId))

    // Trigger background research safely
    const urlsToResearch: { label: string; url: string }[] = []
    
    if (updates.companyUrls && Array.isArray(updates.companyUrls)) {
      updates.companyUrls.forEach((url: string) => {
          if (url && url.startsWith('http')) {
              urlsToResearch.push({ label: 'Resource', url })
          }
      })
    }

    if (urlsToResearch.length > 0) {
      c.executionCtx.waitUntil((async () => {
        try {
          console.log(`🔍 Starting background research for company ${userId} with ${urlsToResearch.length} URLs`)
          const researcher = new CompanyResearch(c.env.GEMINI_API_KEY, c.env.BROWSERBASE_API_KEY)
          await researcher.init()
          
          let collectiveSummary = ''
          let collectiveImages: any[] = []

          // Simple iteration logic across URLs
          for (const item of urlsToResearch) {
             const results = await researcher.companyUrlResearch(item.url, "Extract company overarching brand identity, primary colors, target demographic design, and any logo/icon themes.")
             if (results.researchSummary) collectiveSummary += results.researchSummary + '\n'
             if (results.imageAnalysis) collectiveImages = collectiveImages.concat(results.imageAnalysis)
          }

          console.log(`✅ Research completed for company ${userId}`)
          
          await getDb(c.env.DATABASE_URL).update(profiles).set({
             preferences: sql`jsonb_set(
               ${profiles.preferences}, 
               '{company,brandDetails}', 
               ${JSON.stringify({
                   ...updates.brandDetails,
                   researchSummary: collectiveSummary,
                   images: collectiveImages,
                   lastUpdated: new Date()
               })}::jsonb
             )`
          }).where(eq(profiles.userId, userId))

          await researcher.close()
        } catch (error) {
          console.error(`❌ Background research failed for company ${userId}:`, error)
        }
      })())
    }

    // Sync to Vector Memory
    c.executionCtx.waitUntil((async () => {
      try {
        if (!c.env.QDRANT_URL) {
          console.warn('QDRANT_URL not configured. Skipping memory sync.')
          return
        }

        const memoryService = new MemoryService(c.env.QDRANT_URL, c.env.QDRANT_API_KEY)
        const fullPrefs = { ...updates, userId }
        const prefText = `Company Preferences: ${JSON.stringify(fullPrefs)}`

        // See note above regarding 768 vector generation.
        console.warn('Memory Sync requires a 768 length array from an embedding model to use addMemory. Ensure you pass Google Gemini/Vertex embedding result here.');

      } catch (memErr) {
        console.warn('Failed to sync company preferences to vector DB:', memErr)
      }
    })())

    return c.json({ success: true, message: 'Company preferences updated successfully' })
  } catch (error) {
    console.error('updateCompanyPreferences error:', error)
    return c.json({ error: 'Failed to update company preferences' }, 500)
  }
}

// Map the routes
user.get('/:userId/profile', getUserProfile)
user.put('/:userId/profile', updateUserProfile)
user.get('/:userId/preferences', getUserPreferences)
user.put('/:userId/preferences', updateUserPreferences)
user.get('/:userId/company-preferences', getCompanyPreferences)
user.put('/:userId/company-preferences', updateCompanyPreferences)

export default user
