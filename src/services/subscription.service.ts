import { eq, and, isNull } from "drizzle-orm";
import { subscriptions, plans, userCredits } from "../db/schema";

export interface AccessResult {
  allowed: boolean;
  message?: string;
  subscription?: any;
  plan?: any;
  creditsRemaining?: number;
}

export class SubscriptionService {
  constructor(private db: any) { }

  /**
   * Fetches the user's current active subscription and its plan details.
   */
  async getActiveSubscription(userId: string) {
    const [result] = await this.db.select({
      subscription: subscriptions,
      plan: plans,
      credits: userCredits.creditsRemaining
    })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .leftJoin(userCredits, eq(subscriptions.userId, userCredits.userId))
      .where(and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, 'active')
      ))
      .limit(1);

    return result;
  }

  /**
   * Checks if the user is allowed to perform an action based on their subscription and credits.
   */
  async checkAccess(userId: string): Promise<AccessResult> {
    const activeSub = await this.getActiveSubscription(userId);

    if (!activeSub) {
      return {
        allowed: false,
        message: "No active subscription found. Please upgrade your plan."
      };
    }

    // Check if credits are remaining
    if (activeSub.credits !== null && activeSub.credits <= 0) {
      return {
        allowed: false,
        message: "You have run out of credits. Please top up or upgrade your plan."
      };
    }

    // Check if subscription has expired
    if (activeSub.subscription.currentPeriodEnd && new Date() > activeSub.subscription.currentPeriodEnd) {
      return {
        allowed: false,
        message: "Your subscription has expired. Please renew to continue."
      };
    }

    return {
      allowed: true,
      subscription: activeSub.subscription,
      plan: activeSub.plan,
      creditsRemaining: activeSub.credits
    };
  }


  async deductCredits(userId: string, credits: number, reason: string = 'usage', referenceId?: string) {

    try {
      const result = await this.db.execute(
        `UPDATE user_credits SET credits_remaining = credits_remaining - $1 WHERE user_id = $2 RETURNING credits_remaining`,
        [credits, userId]
      );

      return { success: true, data: { creditsRemaining: result.rows[0].credits_remaining } };
    } catch (error: any) {
      return { success: false, error: error.message };
    }

  }
}
