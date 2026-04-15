import { DurableObject } from "cloudflare:workers";

export class GlobalLimiter extends DurableObject {
  private activeRequests: number = 0;
  private readonly MAX_CONCURRENT = 100;

  /**
   * Checks if the global limit has been reached.
   * Increments the count if within limits.
   */
  async checkAndIncrement(): Promise<{ allowed: boolean; current: number }> {
    if (this.activeRequests >= this.MAX_CONCURRENT) {
      return { allowed: false, current: this.activeRequests };
    }
    this.activeRequests++;
    return { allowed: true, current: this.activeRequests };
  }

  /**
   * Decrements the active request count.
   */
  async decrement(): Promise<number> {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    return this.activeRequests;
  }

  /**
   * Returns current load.
   */
  async getStatus(): Promise<number> {
    return this.activeRequests;
  }
}
