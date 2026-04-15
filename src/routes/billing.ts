import { Hono } from 'hono'
import { Webhook } from 'standardwebhooks'
import { getDb } from '../db'
import { BillingService } from '../services/billing.service'
import { plans } from '../db/schema'
import { sessionMiddleware } from '../middleware/auth'

const billing = new Hono<{ 
  Bindings: { 
    DATABASE_URL: string,
    DODO_PAYMENTS_API_KEY: string,
    DODO_WEBHOOK_SECRET: string,
    ENV: string,
    FRONTEND_URL: string
  },
  Variables: {
    user: any
  }
}>()

/**
 * List available subscription plans.
 */
billing.get('/plans', async (c) => {
  const db = getDb(c.env.DATABASE_URL)
  const allPlans = await db.select().from(plans)
  return c.json(allPlans)
})

/**
 * Create a real Dodo Checkout Session.
 */
billing.post('/checkout', sessionMiddleware, async (c) => {
  const user = c.get('user')
  const { planId } = await c.req.json()

  if (!planId) {
    return c.json({ error: 'Missing planId' }, 400)
  }

  try {
    const db = getDb(c.env.DATABASE_URL)
    const billingService = new BillingService(db, c.env)
    
    const returnUrl = `${c.env.FRONTEND_URL || 'http://localhost:3000'}/billing?success=true`
    const checkoutUrl = await billingService.createCheckout(user.id, planId, returnUrl)
    
    return c.json({ checkoutUrl })
  } catch (error: any) {
    console.error('Checkout Error:', error)
    return c.json({ error: error.message || 'Failed to create checkout' }, 500)
  }
})

/**
 * SECURE Webhook handler for Dodo Payments.
 * Verifies signatures using standardwebhooks.
 */
billing.post('/webhook/dodo', async (c) => {
  const secret = c.env.DODO_WEBHOOK_SECRET
  if (!secret) {
    console.error('DODO_WEBHOOK_SECRET is not configured')
    return c.json({ error: 'Webhook secret missing' }, 500)
  }

  try {
    // 1. Extract Webhook Headers
    const headers = {
      'webhook-id': c.req.header('webhook-id'),
      'webhook-signature': c.req.header('webhook-signature'),
      'webhook-timestamp': c.req.header('webhook-timestamp'),
    }

    if (!headers['webhook-signature']) {
      return c.json({ error: 'Missing webhook signature' }, 400)
    }

    // 2. Get Raw Body (Crucial for signature verification)
    const rawBody = await c.req.text()

    // 3. Verify Signature
    const wh = new Webhook(secret)
    await wh.verify(rawBody, headers as any)

    // 4. Process Verified Payload
    const payload = JSON.parse(rawBody)
    const db = getDb(c.env.DATABASE_URL)
    const billingService = new BillingService(db, c.env)

    console.log(`[Dodo Webhook] Received ${payload.type} for ${payload.data?.subscription_id}`)
    await billingService.handleWebhookEvent(payload)

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Webhook Verification Failed:', error.message)
    return c.json({ error: 'Invalid signature' }, 400)
  }
})

export default billing
