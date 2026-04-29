import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db'
import { waitlist } from '../db/schema'
import { eq, sql } from 'drizzle-orm'

import { sendWaitlistWelcomeEmail } from '../lib/email'

type Bindings = {
  DATABASE_URL: string
  RESEND_API_KEY: string
}

const waitlistRouter = new Hono<{ Bindings: Bindings }>()

// --- Schemas ---
const joinWaitlistSchema = z.object({
  email: z.string().email({ message: "Email is required" }),
  name: z.string().optional(),
  company_name: z.string().optional(),
  website: z.string().optional(),
  team_size: z.string().optional(),
  brand_stage: z.string().optional(),
  primary_need: z.array(z.string()).optional(),
  additional_info: z.string().optional(),
})

// --- Endpoints ---

// 1. Join Waitlist
// POST /api/waitlist (Registered as POST /waitlist in this router)
waitlistRouter.post('/waitlist', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const body = await c.req.json()
  const result = joinWaitlistSchema.safeParse(body)

  if (!result.success) {
    const firstError = result.error.issues[0]?.message || 'Invalid input'
    return c.json({ error: firstError }, 400)
  }

  const { 
    email, 
    name, 
    company_name, 
    website, 
    team_size, 
    brand_stage, 
    primary_need, 
    additional_info 
  } = result.data

  try {
    // 1. Check if email already exists
    const [existing] = await db.select().from(waitlist).where(eq(waitlist.email, email)).limit(1)
    if (existing) {
      return c.json({ message: "Email already registered" }, 409)
    }

    // 2. Insert new record
    await db.insert(waitlist).values({
      email,
      name,
      companyName: company_name,
      website,
      teamSize: team_size,
      brandStage: brand_stage,
      primaryNeed: primary_need,
      additionalInfo: additional_info,
    })

    // 3. Send Founder's Welcome Email (Async)
    c.executionCtx.waitUntil((async () => {
      try {
        if (c.env.RESEND_API_KEY) {
          const emailResponse = await sendWaitlistWelcomeEmail(c.env.RESEND_API_KEY, email, name)
          if (emailResponse.error) {
            console.error('❌ Waitlist welcome email failed:', emailResponse.error);
          } else {
            console.log('✅ Waitlist welcome email sent to:', email);
          }
        } else {
          console.error('❌ RESEND_API_KEY is missing. Cannot send waitlist email.');
        }
      } catch (err) {
        console.error('❌ Unexpected email error in waitlist waitUntil:', err);
      }
    })())

    return c.json({ message: "Successfully joined the waitlist!" }, 201)

  } catch (error: any) {
    console.error('Waitlist Join Error:', error)
    return c.json({ error: "Failed to join waitlist" }, 500)
  }
})

// 2. Get Waitlist Count
// GET /api/w-v1 (Registered as GET /w-v1 in this router)
waitlistRouter.get('/w-v1', async (c) => {
  const db = getDb(c.env.DATABASE_URL)

  try {
    const result = await db.select({ count: sql<number>`count(*)` }).from(waitlist)
    const count = Number(result[0]?.count || 0)

    return c.json({ count })

  } catch (error: any) {
    console.error('Waitlist Count Error:', error)
    return c.json({ error: "Failed to get waitlist count" }, 500)
  }
})

export default waitlistRouter
