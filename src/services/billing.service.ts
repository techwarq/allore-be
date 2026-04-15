import { eq, sql, and } from "drizzle-orm";
import DodoPayments from 'dodopayments';
import { users, userCredits, subscriptions, plans, invoices, creditTransactions } from "../db/schema";

export class BillingService {
  private dodo: DodoPayments;

  constructor(private db: any, env: { DODO_PAYMENTS_API_KEY: string, ENV: string }) {
    this.dodo = new DodoPayments({
      bearerToken: env.DODO_PAYMENTS_API_KEY,
      environment: env.ENV === 'production' ? 'live_mode' : 'test_mode'
    });
  }

  /**
   * Generates a hosted checkout URL for a subscription.
   */
  async createCheckout(userId: string, planId: string, returnUrl: string) {
    // 1. Fetch Plan Details
    const [plan] = await this.db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) throw new Error("Plan not found");

    // 2. Fetch User Details for Dodo
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error("User not found");

    // 3. Create Dodo Checkout Session
    const session = await this.dodo.checkoutSessions.create({
      product_cart: [
        { product_id: planId, quantity: 1 } // Using our planId as Dodo productId
      ],
      customer: {
        email: user.email,
        name: user.email.split('@')[0], // Fallback name
      },
      return_url: returnUrl,
    });

    return session.checkout_url;
  }

  /**
   * Main entry point for processing verified Dodo webhooks.
   */
  async handleWebhookEvent(payload: any) {
    const { type, data } = payload;

    switch (type) {
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
        await this.createInvoiceFromPayment(data);
        break;
    }
  }

  private async handleSubscriptionRenewal(data: any) {
    const { subscription_id, customer: dodoCustomer, product_id } = data;
    const email = dodoCustomer?.email;
    if (!email) return;

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return;

    // Use our internal activateSubscription logic to grant credits
    await this.activateSubscription(user.id, product_id, subscription_id);
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

    await this.db.insert(invoices).values({
      userId: user.id,
      subscriptionId: subscription_id, // Map if exists
      amount: (amount / 100).toString(), // Dodo usually uses cents
      status: 'paid',
      dodoPaymentId: payment_id
    }).onConflictDoNothing();
  }

  /**
   * Checks if a user has sufficient balance or an active subscription to access services.
   */
  async validateAccess(userId: string): Promise<{ allowed: boolean; credits?: number; error?: string }> {
    const [credits] = await this.db.select()
      .from(userCredits)
      .where(eq(userCredits.userId, userId))
      .limit(1);

    if (!credits) {
      return { allowed: false, error: "Billing account not initialized." };
    }

    const [subscription] = await this.db.select({
      status: subscriptions.status,
      planName: plans.name
    })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(and(
      eq(subscriptions.userId, userId),
      eq(subscriptions.status, 'active')
    ))
    .limit(1);

    if (credits.creditsRemaining <= 0) {
      if (!subscription) {
        return { allowed: false, error: "Insufficient credits. Please upgrade to continue." };
      }
    }

    return { 
      allowed: true,
      credits: credits.creditsRemaining
    };
  }

  /**
   * Records token usage and deducts credits.
   */
  async recordUsage(userId: string, tokensUsed: number, cost: number) {
    const costInCredits = Math.max(1, Math.ceil(cost * 100));

    await this.db.transaction(async (tx: any) => {
      await tx.update(userCredits)
        .set({ creditsRemaining: sql`${userCredits.creditsRemaining} - ${costInCredits}` })
        .where(eq(userCredits.userId, userId));

      await tx.insert(creditTransactions).values({
        userId,
        changeAmount: -costInCredits,
        reason: 'usage',
        createdAt: new Date()
      });
    });
  }

  /**
   * Activate or renew a monthly subscription using the RESET model.
   */
  async activateSubscription(userId: string, planId: string, dodoSubId: string) {
    const [plan] = await this.db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!plan) throw new Error("Plan not found");

    return await this.db.transaction(async (tx: any) => {
      const [sub] = await tx.insert(subscriptions).values({
        userId,
        planId,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        dodoSubscriptionId: dodoSubId
      }).onConflictDoUpdate({
        target: subscriptions.userId, 
        set: { 
          planId,
          status: 'active', 
          currentPeriodStart: new Date(), 
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) 
        }
      }).returning();

      await tx.insert(userCredits).values({
        userId,
        creditsRemaining: plan.monthlyCredits,
        lastResetAt: new Date()
      }).onConflictDoUpdate({
        target: userCredits.userId,
        set: { 
          creditsRemaining: plan.monthlyCredits,
          lastResetAt: new Date()
        }
      });

      await tx.insert(creditTransactions).values({
        userId,
        changeAmount: plan.monthlyCredits,
        reason: 'monthly_grant',
        referenceId: sub.id
      });

      return sub;
    });
  }
}
