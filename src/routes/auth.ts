import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db'
import { users } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { hashPassword, verifyPassword, signJWT, getGoogleProvider } from '../lib/auth'
import { sendVerificationEmail } from '../lib/email'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { generateState, generateCodeVerifier } from 'arctic'

type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  RESEND_API_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  FRONTEND_URL: string
  API_URL: string
}

const auth = new Hono<{ Bindings: Bindings }>()

// --- Schemas ---
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

// --- Endpoints ---

// 📝 Manual Signup
auth.post('/signup', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const body = await c.req.json()
  const result = signupSchema.safeParse(body)

  if (!result.success) {
    return c.json({ error: 'Invalid input', details: result.error.format() }, 400)
  }

  const { email, password, name } = result.data

  // Check if user exists
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existingUser.length > 0) {
    return c.json({ error: 'User already exists' }, 409)
  }

  const hashedPassword = await hashPassword(password)
  const verificationToken = crypto.randomUUID()
  const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

  const [newUser] = await db.insert(users).values({
    email,
    password: hashedPassword,
    name,
    authProvider: 'local',
    verificationToken,
    verificationExpiresAt,
  }).returning()

  // Send verification email
  const emailResponse = await sendVerificationEmail(c.env.RESEND_API_KEY, email, verificationToken, c.env.API_URL)

  if (emailResponse.error) {
    // Cleanup: Delete the user if email failed to send
    await db.delete(users).where(eq(users.id, newUser.id))
    return c.json({ 
      error: 'Failed to send verification email. Cleanup performed.', 
      details: emailResponse.error 
    }, 500)
  }

  return c.json({ message: 'User created. Please check your email for verification.', userId: newUser.id }, 201)
})

// 🔑 Manual Login
auth.post('/login', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const body = await c.req.json()
  const result = loginSchema.safeParse(body)

  if (!result.success) {
    return c.json({ error: 'Invalid credentials' }, 400)
  }

  const { email, password } = result.data
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!user || !user.password) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const isPasswordValid = await verifyPassword(password, user.password)
  if (!isPasswordValid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  if (!user.isVerified) {
    return c.json({ error: 'Please verify your email before logging in' }, 403)
  }

  const token = await signJWT({ userId: user.id, email: user.email, role: user.role }, c.env.JWT_SECRET)

  setCookie(c, 'auth_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  })

  return c.json({ message: 'Login successful', user: { id: user.id, name: user.name, email: user.email } })
})

// 🌐 Google Auth Redirect
auth.get('/google', async (c) => {
  const google = getGoogleProvider(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.API_URL}/auth/google/callback`)
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await google.createAuthorizationURL(state, codeVerifier, ['profile', 'email'])

  setCookie(c, 'google_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 10, // 10 minutes
  })

  setCookie(c, 'google_code_verifier', codeVerifier, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 10, // 10 minutes
  })

  return c.redirect(url.toString())
})

// 🌐 Google Auth Callback
auth.get('/google/callback', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const query = c.req.query()
  const code = query.code
  const state = query.state
  const storedState = getCookie(c, 'google_oauth_state')
  const storedCodeVerifier = getCookie(c, 'google_code_verifier')

  if (!code || !state || !storedState || state !== storedState || !storedCodeVerifier) {
    return c.json({ error: 'Invalid state or code' }, 400)
  }

  const google = getGoogleProvider(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.API_URL}/auth/google/callback`)
  
  try {
    const tokens = await google.validateAuthorizationCode(code, storedCodeVerifier)
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`
        }
    })
    const googleUser: any = await response.json()

    // Find or create user
    let [user] = await db.select().from(users).where(eq(users.email, googleUser.email)).limit(1)

    if (!user) {
        [user] = await db.insert(users).values({
            email: googleUser.email,
            name: googleUser.name || googleUser.given_name,
            googleId: googleUser.sub,
            authProvider: 'google',
            isVerified: true, // Google accounts are pre-verified
        }).returning()
    } else if (user.authProvider === 'local') {
        // Upgrade local user to also support google
        await db.update(users).set({ 
            googleId: googleUser.sub, 
            authProvider: 'both',
            isVerified: true 
        }).where(eq(users.id, user.id))
    }

    const token = await signJWT({ userId: user.id, email: user.email, role: user.role }, c.env.JWT_SECRET)

    setCookie(c, 'auth_session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    })

    return c.redirect(c.env.FRONTEND_URL)
  } catch (error) {
    return c.json({ error: 'Auth failed' }, 500)
  }
})

// ✅ Email Verification
auth.get('/verify-email', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const token = c.req.query('token')

  if (!token) return c.json({ error: 'Missing token' }, 400)

  const [user] = await db.select().from(users).where(eq(users.verificationToken, token)).limit(1)

  if (!user || (user.verificationExpiresAt && user.verificationExpiresAt < new Date())) {
    return c.redirect(`${c.env.FRONTEND_URL}/login?error=invalid_token`)
  }

  await db.update(users).set({
    isVerified: true,
    verificationToken: null,
    verificationExpiresAt: null,
  }).where(eq(users.id, user.id))

  return c.redirect(`${c.env.FRONTEND_URL}/login?verified=true`)
})

// 🚪 Logout
auth.post('/logout', (c) => {
  deleteCookie(c, 'auth_session')
  return c.json({ message: 'Logged out' })
})

// 🔐 Forgot Password
auth.post('/forgot-password', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const { email } = await c.req.json()

  if (!email) return c.json({ error: 'Email is required' }, 400)

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!user) {
    // Return success even if user doesn't exist for security (avoiding email enumeration)
    return c.json({ message: 'If an account exists with this email, a reset link has been sent.' })
  }

  const resetToken = crypto.randomUUID()
  const resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  await db.update(users).set({
    resetPasswordToken: resetToken,
    resetPasswordExpiresAt: resetExpiresAt
  }).where(eq(users.id, user.id))

  // Send cinematic reset email
  const { sendPasswordResetEmail } = await import('../lib/email')
  await sendPasswordResetEmail(c.env.RESEND_API_KEY, email, resetToken, c.env.API_URL)

  return c.json({ message: 'Reset link sent successfully' })
})

// 🔐 Reset Password
auth.post('/reset-password', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const { token, newPassword } = await c.req.json()

  if (!token || !newPassword) return c.json({ error: 'Token and new password are required' }, 400)

  const [user] = await db.select().from(users).where(eq(users.resetPasswordToken, token)).limit(1)

  if (!user || (user.resetPasswordExpiresAt && user.resetPasswordExpiresAt < new Date())) {
    return c.json({ error: 'Invalid or expired reset token' }, 400)
  }

  const hashedPassword = await hashPassword(newPassword)

  await db.update(users).set({
    password: hashedPassword,
    resetPasswordToken: null,
    resetPasswordExpiresAt: null
  }).where(eq(users.id, user.id))

  return c.json({ message: 'Password reset successful. You can now log in.' })
})

export default auth
