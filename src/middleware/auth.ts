import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { verifyJWT } from '../lib/auth'

export type AuthVariables = {
  user: {
    userId: string
    email: string
    role: 'user' | 'admin'
  }
}

export const sessionMiddleware = createMiddleware<{
  Bindings: { JWT_SECRET: string }
  Variables: AuthVariables
}>(async (c, next) => {
  const token = getCookie(c, 'auth_session')

  if (!token) {
    return c.json({ error: 'Unauthorized: No session' }, 401)
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET)

  if (!payload) {
    return c.json({ error: 'Unauthorized: Invalid session' }, 401)
  }

  c.set('user', payload as AuthVariables['user'])
  await next()
})
