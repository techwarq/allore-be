import { Hono } from 'hono'
import { z } from 'zod'
import { getDb } from '../db'
import { users, authAccounts, sessions, emailVerifications, profiles, userCredits } from '../db/schema'
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

  try {
    console.log(`🚀 Starting signup for ${email}`);
    
    // 0. Verify Environment
    if (!c.env.JWT_SECRET) console.error('❌ JWT_SECRET is missing');
    if (!c.env.RESEND_API_KEY) console.error('❌ RESEND_API_KEY is missing');

    // 1. Check if user exists
    const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (existingUser) {
      return c.json({ error: 'User already exists' }, 409)
    }

    // 2. Create Base User
    console.log('--- Step 2: Creating users entry');
    const [newUser] = await db.insert(users).values({ email }).returning()
    if (!newUser) throw new Error('Failed to create user record');

    // 3. Create Auth Account (Local)
    console.log('--- Step 3: Creating auth_accounts entry');
    const hashedPassword = await hashPassword(password)
    await db.insert(authAccounts).values({
      userId: newUser.id,
      provider: 'local',
      passwordHash: hashedPassword,
    })

    // 4. Create Initial Profile
    console.log('--- Step 4: Creating profiles entry');
    await db.insert(profiles).values({
      userId: newUser.id,
      name: name,
    })

    // 5. Initialize Credits
    console.log('--- Step 5: Creating user_credits entry');
    await db.insert(userCredits).values({
      userId: newUser.id,
      creditsRemaining: 10,
    })

    // 6. Create Email Verification Token
    console.log('--- Step 6: Creating email_verifications entry');
    const verificationToken = crypto.randomUUID()
    const tokenHash = btoa(verificationToken)
    await db.insert(emailVerifications).values({
      userId: newUser.id,
      tokenHash: tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    // 7. Send verification email (Async via waitUntil)
    console.log('--- Step 7: Queueing verification email');
    c.executionCtx.waitUntil((async () => {
      try {
        const emailResponse = await sendVerificationEmail(c.env.RESEND_API_KEY, email, tokenHash, c.env.API_URL)
        if (emailResponse.error) {
          console.error('❌ Verification email failed:', emailResponse.error);
        } else {
          console.log('✅ Verification email sent to:', email);
        }
      } catch (err) {
        console.error('❌ Unexpected email error in waitUntil:', err);
      }
    })())

    console.log('✨ Signup sequence complete');
    return c.json({ 
      message: 'User created. Please check your email for verification.', 
      userId: newUser.id 
    }, 201)

  } catch (error: any) {
    console.error('❌ CRITICAL Signup Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500)
  }
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
  
  // 1. Get User
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  // 2. Get Auth Account
  const [account] = await db.select()
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.provider, 'local')))
    .limit(1)

  if (!account || !account.passwordHash) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  // 3. Verify Password
  const isPasswordValid = await verifyPassword(password, account.passwordHash)
  if (!isPasswordValid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  // 4. Check Verification
  if (!user.emailVerified) {
    return c.json({ error: 'Please verify your email before logging in' }, 403)
  }

  // 5. Create Session
  const sessionToken = crypto.randomUUID()
  const [session] = await db.insert(sessions).values({
    userId: user.id,
    sessionToken: sessionToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    userAgent: c.req.header('user-agent'),
    ipAddress: c.req.header('x-real-ip') || c.req.header('cf-connecting-ip'),
  }).returning()

    setCookie(c, 'auth_session', session.sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })

  return c.json({ 
    message: 'Login successful', 
    user: { id: user.id, email: user.email } 
  })
})

// 🚪 Logout
auth.post('/logout', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const sessionToken = getCookie(c, 'auth_session')
  
  if (sessionToken) {
    await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken))
  }
  
  deleteCookie(c, 'auth_session')
  return c.json({ message: 'Logged out' })
})

// ✅ Email Verification
auth.get('/verify-email', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const token = c.req.query('token')

  if (!token) return c.json({ error: 'Missing token' }, 400)

  const [verification] = await db.select()
    .from(emailVerifications)
    .where(and(eq(emailVerifications.tokenHash, token), eq(emailVerifications.verified, false)))
    .limit(1)

  if (!verification || verification.expiresAt < new Date()) {
    return c.redirect(`${c.env.FRONTEND_URL}/login?error=invalid_token`)
  }

  // Update verification status and user status
  await db.update(emailVerifications).set({ verified: true }).where(eq(emailVerifications.id, verification.id))
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, verification.userId))

  return c.redirect(`${c.env.FRONTEND_URL}/login?verified=true`)
})

// 🌐 Google Auth Redirect (Placeholder - logic would follow similar pattern with authAccounts)
auth.get('/google', async (c) => {
  const google = getGoogleProvider(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${c.env.API_URL}/auth/google/callback`)
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await google.createAuthorizationURL(state, codeVerifier, ['profile', 'email'])

  setCookie(c, 'google_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 60 * 10 })
  setCookie(c, 'google_code_verifier', codeVerifier, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 60 * 10 })

  return c.redirect(url.toString())
})

export default auth
