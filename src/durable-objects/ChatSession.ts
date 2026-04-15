import { DurableObject } from "cloudflare:workers";

export interface SessionState {
  isLocked: boolean;
  lastRequestId?: string;
}

export class ChatSession extends DurableObject {
  private isLocked: boolean = false;
  private currentRequestId: string | null = null;
  private abortController: AbortController | null = null;

  /**
   * Attempts to lock the session for a new request.
   */
  async lock(requestId: string): Promise<{ success: boolean; message?: string }> {
    if (this.isLocked) {
      return { 
        success: false, 
        message: "Session is busy. Please wait for the current request to complete." 
      };
    }
    this.isLocked = true;
    this.currentRequestId = requestId;
    this.abortController = new AbortController();
    return { success: true };
  }

  /**
   * Unlocks the session.
   */
  async unlock(requestId: string): Promise<void> {
    if (this.currentRequestId === requestId) {
      this.isLocked = false;
      this.currentRequestId = null;
      this.abortController = null;
    }
  }

  /**
   * Cancels the currently active request.
   */
  async cancel(): Promise<{ success: boolean; message: string }> {
    if (!this.isLocked || !this.abortController) {
      return { success: false, message: "No active request to cancel." };
    }
    
    this.abortController.abort();
    this.isLocked = false;
    this.currentRequestId = null;
    this.abortController = null;
    
    return { success: true, message: "Request cancelled successfully." };
  }

  /**
   * Gets current session status.
   */
  async getStatus(): Promise<SessionState> {
    return {
      isLocked: this.isLocked,
      lastRequestId: this.currentRequestId || undefined
    };
  }
}
