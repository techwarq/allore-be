import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db'
import { feedback } from '../db/schema'

type Bindings = { DATABASE_URL: string }

const router = new Hono<{ Bindings: Bindings }>()

const schema = z.object({
  message: z.string().min(1),
  email: z.string().email().optional(),
})

router.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const rows = await db.select().from(feedback).orderBy(feedback.createdAt)
  return c.json(rows)
})

router.post('/', async (c) => {
  const body = await c.req.json()
  const result = schema.safeParse(body)
  if (!result.success) {
    return c.json({ error: result.error.issues[0]?.message || 'Invalid input' }, 400)
  }

  const db = getDb(c.env.DATABASE_URL)
  await db.insert(feedback).values(result.data)
  return c.json({ ok: true }, 201)
})

export default router
