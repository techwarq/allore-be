import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { getDb } from '../db'
import { sessions, users } from '../db/schema'
import { eq, and, gt } from 'drizzle-orm'

export type AuthVariables = {
  user: {
    id: string
    email: string
    role: string
  }
}

export const sessionMiddleware = createMiddleware<{
  Bindings: { DATABASE_URL: string }
  Variables: AuthVariables
}>(async (c, next) => {
  const sessionToken = getCookie(c, 'auth_session')

  if (!sessionToken) {
    return c.json({ error: 'Unauthorized: No session token' }, 401)
  }

  const db = getDb(c.env.DATABASE_URL)

  try {
    // 1. Find valid session and join with user
    const [result] = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      expiresAt: sessions.expiresAt
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.sessionToken, sessionToken),
      gt(sessions.expiresAt, new Date())
    ))
    .limit(1)

    if (!result) {
      console.warn(`[Auth] Invalid or expired session for token: ${sessionToken.substring(0, 8)}...`);
      return c.json({ error: 'Unauthorized: Invalid or expired session' }, 401)
    }

    // 2. Set user in context
    c.set('user', {
      id: result.id,
      email: result.email,
      role: result.role
    })

    await next()

  } catch (error) {
    console.error('Session Middleware Error:', error)
    return c.json({ error: 'Internal Server Error during authentication' }, 500)
  }
})
