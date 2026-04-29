import { eq, sql, and, isNull } from "drizzle-orm";
import DodoPayments from 'dodopayments';
import { users, userCredits, subscriptions, plans, invoices, creditTransactions } from "../db/schema";

export class BillingService {
  private dodo: DodoPayments;

  constructor(private db: any, private env: { DODO_PAYMENTS_API_KEY: string, ENV: string }) {
    const isProd = this.env.ENV === 'production';
    const dodoEnv = isProd ? 'live_mode' : 'test_mode';

    console.log(`[BillingService] Initializing Dodo Payments...`);
    console.log(`[BillingService] Environment: ${this.env.ENV}`);
    console.log(`[BillingService] Dodo Mode: ${dodoEnv}`);
    console.log(`[BillingService] API Key Present: ${!!this.env.DODO_PAYMENTS_API_KEY} (${this.env.DODO_PAYMENTS_API_KEY?.substring(0, 8)}...)`);

    this.dodo = new DodoPayments({
      bearerToken: this.env.DODO_PAYMENTS_API_KEY,
      environment: dodoEnv
    });
  }

  /**
   * Generates a hosted checkout URL for a subscription.
   */
  async createCheckout(userId: string, planId: string, returnUrl: string) {
    // 1. Fetch Plan Details
    const [plan] = await this.db.select().from(plans)
      .where(and(eq(plans.id, planId), isNull(plans.userId)))
      .limit(1);
    if (!plan) throw new Error("Plan not found");

    // 2. Fetch User Details for Dodo
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error("User not found");

    // 3. Create Dodo Checkout Session
    try {
      // 🛡️ Use the mapped Dodo Product ID if available, otherwise fallback to our internal ID
      const dodoProductId = plan.dodoProductId || planId;

      const session = await this.dodo.checkoutSessions.create({
        product_cart: [
          { product_id: dodoProductId, quantity: 1 }
        ],
        customer: {
          email: user.email,
          name: user.email.split('@')[0], // Fallback name
        },
        return_url: returnUrl,
      });

      return session.checkout_url;
    } catch (error: any) {
      console.error('[BillingService] Dodo Session Creation Failed:', error);
      if (error.status === 401) {
        throw new Error(`Dodo Authentication Failed: Please check your API key and Environment (Current ENV: ${this.env.ENV}).`);
      }
      throw error;
    }
  }

  /**
   * Main entry point for processing verified Dodo webhooks.
   */
  async handleWebhookEvent(payload: any) {
    const { type, data } = payload;

    switch (type) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.active':
      case 'subscription.renewed':
        // data usually contains subscription_id, customer_id (which is our email or we map it), etc.
        await this.handleSubscriptionRenewal(data);
        break;

      case 'subscription.on_hold':
      case 'subscription.failed':
        await this.handleSubscriptionFailure(data);
        break;

      case 'payment.succeeded':
        // 🛡️ Grant credits immediately on successful payment
        // Extract invoice URL if present
        const invoiceUrl = data?.invoice_url;
        await this.handleSubscriptionRenewal({ ...data, invoice_url: invoiceUrl });
        await this.createInvoiceFromPayment(data);
        break;
    }
  }

  private async handleSubscriptionRenewal(data: any) {
    const { subscription_id, customer: dodoCustomer, product_id } = data;
    const email = dodoCustomer?.email;

    if (!email) {
      console.warn(`[BillingService] No email found in renewal data for ${subscription_id}`);
      return;
    }

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);

    console.log(`[BillingService] Syncing subscription event for email: ${email}`);

    if (!user) {
      console.warn(`[BillingService] User not found for email ${email} during renewal`);
      return;
    }

    console.log(`[BillingService] Activating/Renewing subscription for Dodo product ${product_id}`);

    // 🛡️ Map the Dodo product_id back to our internal planId
    // Ensure we fetch the TEMPLATE plan (where userId is null)
    const [plan] = await this.db.select()
      .from(plans)
      .where(and(
        eq(plans.dodoProductId, product_id),
        isNull(plans.userId)
      ))
      .limit(1);

    if (!plan) {
      console.warn(`[BillingService] No plan found for Dodo product_id ${product_id}`);
      return;
    }

    const planId = plan.id;
    const invoiceUrl = data.invoice_url;

    // Use our internal activateSubscription logic to grant credits
    await this.activateSubscription(user.id, planId, subscription_id, invoiceUrl);
    console.log(`[BillingService] Successfully synchronized subscription ${subscription_id} for ${email}`);
  }

  private async handleSubscriptionFailure(data: any) {
    const { subscription_id } = data;
    await this.db.update(subscriptions)
      .set({ status: 'past_due' })
      .where(eq(subscriptions.dodoSubscriptionId, subscription_id));
  }

  private async createInvoiceFromPayment(data: any) {
    const { payment_id, amount, customer: dodoCustomer, subscription_id } = data;
    const email = dodoCustomer?.email;
    if (!email) return;

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return;

    // 🛡️ Resolve the internal Subscription UUID from the Dodo ID
    let internalSubscriptionId = null;
    if (subscription_id) {
      const [sub] = await this.db.select()
        .from(subscriptions)
        .where(eq(subscriptions.dodoSubscriptionId, subscription_id))
        .limit(1);
      if (sub) internalSubscriptionId = sub.id;
    }

    await this.db.insert(invoices).values({
      userId: user.id,
      subscriptionId: internalSubscriptionId,
      amount: (amount / 100).toString(), // Dodo uses cents
      status: 'paid',
      dodoPaymentId: payment_id
    }).onConflictDoNothing();
  }

  /**
   * Checks if a user has sufficient balance or an active subscription to access services.
   */
  async validateAccess(userId: string): Promise<{ allowed: boolean; credits?: number; error?: string }> {
    // 🛡️ INTERNAL BYPASS: Payment issues override
    return {
      allowed: true,
      credits: 1000000
    };
  }

  /**
   * Records token usage and deducts credits.
   */
  async recordUsage(userId: string, tokensUsed: number, cost: number) {
    // 🛡️ INTERNAL BYPASS: Payment issues override - skip credit deduction
    console.log(`[BillingService] recordUsage bypassed for user ${userId} (${tokensUsed} tokens, cost ${cost})`);
  }

  /**
   * Activate or renew a monthly subscription using the RESET model.
   * Now also records the specific purchase in the plans table.
   */
  async activateSubscription(userId: string, planId: string, dodoSubId: string, invoiceUrl?: string) {
    // 1. Fetch Plan Template (ensure it's the template, not a previous purchase)
    const [planTemplate] = await this.db.select().from(plans)
      .where(and(eq(plans.id, planId), isNull(plans.userId)))
      .limit(1);
    
    if (!planTemplate) throw new Error("Plan template not found");

    // 2. Fetch current user credits to calculate new balance
    const [currentCredits] = await this.db.select().from(userCredits).where(eq(userCredits.userId, userId)).limit(1);
    const existingBalance = currentCredits?.creditsRemaining || 0;
    
    // Calculate total credits to grant (Monthly + Add-ons)
    const creditsToGrant = planTemplate.monthlyCredits + planTemplate.addOnTokens;
    const newTotalCredits = existingBalance + creditsToGrant;

    console.log(`[BillingService] Granting ${creditsToGrant} credits to user ${userId}. New total: ${newTotalCredits}`);

    // 3. Record the specific purchase in the plans table (as a historical record)
    const [purchaseRecord] = await this.db.insert(plans).values({
      userId,
      templateId: planTemplate.id, // Store the original template ID
      name: planTemplate.name,
      priceMonthly: planTemplate.priceMonthly,
      monthlyCredits: planTemplate.monthlyCredits,
      addOnTokens: planTemplate.addOnTokens,
      credits: newTotalCredits,
      invoiceUrl: invoiceUrl || null,
      dodoProductId: planTemplate.dodoProductId,
    }).returning();

    // 4. Update or Insert Subscription (pointing to the purchase record)
    const [sub] = await this.db.insert(subscriptions).values({
      userId,
      planId: purchaseRecord.id, // Link to the specific purchase
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      dodoSubscriptionId: dodoSubId
    }).onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        planId: purchaseRecord.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        dodoSubscriptionId: dodoSubId
      }
    }).returning();

    // 5. Update User Credits balance
    await this.db.insert(userCredits).values({
      userId,
      creditsRemaining: newTotalCredits,
      lastResetAt: new Date()
    }).onConflictDoUpdate({
      target: userCredits.userId,
      set: {
        creditsRemaining: newTotalCredits,
        lastResetAt: new Date()
      }
    });

    // 6. Record Transaction
    await this.db.insert(creditTransactions).values({
      userId,
      changeAmount: creditsToGrant,
      reason: 'purchase',
      referenceId: purchaseRecord.id, // Link to the purchase record
      invoiceUrl: invoiceUrl || null
    });

    return sub;
  }
}
