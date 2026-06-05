import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { MemoryServiceV3 } from "../../memory-v3.service";

// ─────────────────────────────────────────────────────────────────────────────
// MemoryRecallTool
//
// Pulls the 3-layer memory context (STM + Episodic + LTM + Graph) for the
// current user and injects it into SessionMemory.memoryContext so that every
// tool that runs afterward has access to it without its own DB/Qdrant calls.
//
// The IntentEngine decides when to include this tool in the task plan.
// It should be first in the list whenever the request is creative or brand-specific.
//
// Input:  { query: string }  — the user's message / intent summary
// Output: memoryUpdate → merged into SessionMemory.memoryContext
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryRecallTool implements Tool {
  name = "memory_recall";
  description =
    "Recalls relevant long-term memory, past interactions, brand context, and learned patterns for the current request. Always call this first on creative or brand-specific tasks.";

  private memory: MemoryServiceV3;

  constructor(env: any) {
    this.memory = new MemoryServiceV3(env);
  }

  async run(input: { query?: string }, ctx: ToolContext): Promise<ToolResponse> {
    const userId    = ctx.userId ?? ctx.memory?.userId;
    const projectId = ctx.memory?.projectId;
    const sessionId = ctx.sessionId ?? "";
    const query     = input.query ?? "";

    if (!userId || !projectId) {
      console.warn("[MemoryRecallTool] Missing userId or projectId — skipping recall");
      return { visible: [] };
    }

    try {
      const full = await this.memory.retrieve(userId, projectId, sessionId, query);

      const memoryContext: NonNullable<ToolContext["memory"]["memoryContext"]> = {
        brand:    full.longTerm.brand,
        insights: full.longTerm.insights,
        graph:    full.longTerm.graph,
        episodic: full.episodic,
        retrievedAt: new Date().toISOString(),
      };

      return {
        visible: [],
        memoryUpdate: { memoryContext } as any,
      };
    } catch (err) {
      // Memory is enhancement, not critical path — degrade silently
      console.error("[MemoryRecallTool] recall failed:", err);
      return { visible: [] };
    }
  }
}
