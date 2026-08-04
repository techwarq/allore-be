import { DurableObject } from "cloudflare:workers";
import { PlannerIntentAgent, IntentPlan } from "../agents/PlannerIntentAgent";
import { ChatEvent, Task, ToolResponse, SessionMemory } from "../../types/chat";
import { ToolContext } from "../../services/chat/tools/Tool";
import { getDb } from "../../db";
import { privateAssets, assets as userAssets, chatMessages } from "../../db/schema";
import { inArray, eq, asc } from "drizzle-orm";
import { TextService } from "../../services/gemini/TextService";
import { getStandardToolCatalog } from "../../services/chat/StandardTools";
import { CreativeStudioTool } from "../../services/chat/tools/CreativeStudioTool";
import { StorytellerTool } from "../../services/chat/tools/StorytellerTool";
import { AvatarGeneratorTool } from "../../services/chat/tools/AvatarGeneratorTool";

// ── Helpers ───────────────────────────────────────────────────────────────────
function isObject(item: any) {
  return item && typeof item === "object" && !Array.isArray(item);
}

function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        output[key] = key in target
          ? deepMerge(target[key], source[key])
          : source[key];
      } else {
        output[key] = source[key];
      }
    });
  }
  return output;
}

export interface OrchestratorEnv {
  GEMINI_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  DATABASE_URL: string;
  API_URL: string;
  OPENAI_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  FAL_KEY?: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  LLM_QUEUE: Queue;
  IMAGE_QUEUE: Queue;
  VIDEO_QUEUE: Queue;
  ASSETS_BUCKET: R2Bucket;
  // Credit-saving switches — "false" stops generation short of the actual image
  // API call and streams the prompt(s) back for review instead.
  IMAGE_GEN_ENABLED?: string;
  PHOTOSHOOT_IMAGE_GEN_ENABLED?: string;
}

export class Orchestrator extends DurableObject<OrchestratorEnv> {

  // ── In-memory state (rebuilt from storage after hibernation) ──────────────
  private initialized = false;
  private memory: SessionMemory = {
    conversation: { answeredQuestions: [] },
    flowControl: { pendingQuestion: null, pendingTasks: [] },
  };
  private history: any[] = [];
  private brandContext: any = {};
  private userId = "";
  private sessionKey = "";
  private attachments: any[] = [];

  // ── Execution state ────────────────────────────────────────────────────────
  private isLocked = false;
  private currentInput: any = {};
  private abortController: AbortController | null = null;

  // ── Stream state ───────────────────────────────────────────────────────────
  private writer: WritableStreamDefaultWriter | null = null;
  private encoder = new TextEncoder();
  private heartbeatInterval: any = null;
  private lockTimeout: any = null;

  // ── Shared services (built once, reused across tools) ─────────────────────
  private textService!: TextService;

  constructor(state: DurableObjectState, env: OrchestratorEnv) {
    super(state, env);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC RPC METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called by the route on every request.
   * Syncs brand context. Idempotent — safe to call even on existing sessions.
   */
  async setContext(
    brandContext: any,
    userId: string = "",
    projectId?: string,
    sessionKey?: string
  ): Promise<void> {
    const storedUserId = await this.ctx.storage.get<string>("userId");

    if (this.initialized || storedUserId) {
      // Session already exists — refresh brand context and ensure memory is hydrated
      await this.ensureHydrated();
      this.brandContext = brandContext;
      if (sessionKey) this.sessionKey = sessionKey;

      // Ensure projectId is always set in memory (defensive)
      if (projectId && !this.memory.projectId) {
        this.memory.projectId = projectId;
      }

      // Re-check for assets if product not locked yet (handles case where user uploaded after session creation)
      if (!this.memory.product?.productLocked && projectId) {
        await this.loadProjectHistory(projectId, userId || this.userId);
      }

      await this.ctx.storage.put("brandContext", brandContext);
      await this.ctx.storage.put("memory", this.memory);
      if (sessionKey) await this.ctx.storage.put("sessionKey", sessionKey);
      this.initialized = true;
      return;
    }

    // First time — seed the session
    this.brandContext = brandContext;
    this.userId = userId;
    this.sessionKey = sessionKey ?? "";
    if (projectId) this.memory.projectId = projectId;

    await this.loadProjectHistory(projectId, userId);

    await this.ctx.storage.put({
      brandContext,
      userId,
      sessionKey: sessionKey ?? "",
      memory: this.memory,
      history: this.history,
    });
    this.initialized = true;
  }

  /**
   * Main entry point. Returns a ReadableStream of SSE events immediately.
   * All work happens inside ctx.waitUntil.
   */
  async process(
    message: string,
    attachments: any[] = []
  ): Promise<ReadableStream> {
    if (this.isLocked) {
      throw new Error("Session is currently processing another request.");
    }

    this.isLocked = true;
    await this.ensureHydrated();

    // Build shared TextService once per request
    this.textService = new TextService(
      this.env.GEMINI_API_KEY,
      this.env.VERTEX_PROJECT_ID,
      this.env.VERTEX_LOCATION,
      this.env.VERTEX_SERVICE_ACCOUNT_EMAIL,
      this.env.VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY
    );

    // Save user message to DB immediately
    // This persists even if the DO crashes mid-execution
    await this.saveMessageToDB(message, "user");

    // Append to in-memory history
    this.history.push({ role: "user", content: message });
    await this.ctx.storage.put("history", this.history);

    // Accumulate attachments across turns
    if (attachments.length > 0) {
      this.memory.conversation.allAttachments = [
        ...(this.memory.conversation.allAttachments ?? []),
        ...attachments,
      ];
    }

    this.attachments = attachments;
    this.abortController = new AbortController();

    // Resolve product from attachments/memory/DB before any tool runs
    await this.resolveAttachments(attachments);

    // Build the SSE stream
    const { readable, writable } = new TransformStream();
    this.writer = writable.getWriter();

    // Heartbeat — keeps SSE alive through Cloudflare's idle timeout.
    // Uses its own event type (not "chat_text") so the client doesn't mistake
    // it for a real status update and blank out whatever status was showing.
    this.heartbeatInterval = setInterval(() => {
      this.sendEvent({ type: "heartbeat" }).catch(() => {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        // Client disconnected — release the lock so the next request isn't blocked
        this.cleanup().catch(console.error);
      });
    }, 15_000);

    // Safety net for hung sync tools. Async tools release the lock proactively
    // (via cleanup() in runNextStep) before this ever fires.
    this.armLockTimeout();

    // All orchestration runs in waitUntil — non-blocking
    this.ctx.waitUntil(this.orchestrate(message, attachments));

    return readable;
  }

  /**
   * Dev/debug escape hatch — clears the shoot-flow flags directly, for sessions
   * that got stuck stranded before the reset-on-completion fix existed (or any
   * future case where a job never calls back). Not part of the normal request path.
   */
  async resetShootState(): Promise<void> {
    await this.ensureHydrated();
    this.memory = deepMerge(this.memory, {
      campaign: { ...this.memory.campaign, shootEngineQueued: false, shootConfirmed: false },
    });
    await this.persist();
  }

  /**
   * Called by queue workers when an async tool finishes.
   * This is the RPC callback — must re-hydrate if DO hibernated.
   */
  async handleToolResult(tool: string, result: ToolResponse, jobId?: string): Promise<void> {
    // DO may have hibernated between enqueue and callback — re-hydrate
    await this.ensureHydrated();

    if (result.memoryUpdate) {
      this.memory = deepMerge(this.memory, result.memoryUpdate);
    }

    // ── Async polling mode ─────────────────────────────────────────────────────
    // The stream was closed before this queue job ran (writer is null).
    // Accumulate events in DO storage; client polls pollJobResult().
    if (!this.writer && jobId) {
      const existing = await this.ctx.storage.get<ChatEvent[]>(`job:${jobId}:events`) ?? [];
      await this.ctx.storage.put(`job:${jobId}:events`, [
        ...existing,
        ...(result.visible ?? []),
      ]);

      const remaining = ((await this.ctx.storage.get<number>(`job:${jobId}:pendingCount`)) ?? 1) - 1;
      await this.ctx.storage.put(`job:${jobId}:pendingCount`, remaining);

      if (remaining <= 0) {
        await this.ctx.storage.put(`job:${jobId}:status`, "done");
        console.log(`[Orchestrator] Async job ${jobId} complete — ${existing.length + (result.visible?.length ?? 0)} events stored`);
      }

      await this.persist();
      return;
    }

    // ── Sync streaming mode ────────────────────────────────────────────────────
    if (result.nextTasks?.length) {
      this.memory.flowControl.pendingTasks.unshift(...result.nextTasks);
    }

    for (const event of result.visible ?? []) {
      if (event.type === "chat_text" && event.ai) {
        this.history.push({ role: "assistant", content: event.ai });
      }
      await this.sendEvent(event);
    }

    if (result.nextInput) {
      this.currentInput = result.nextInput;
    }

    await this.persist();

    if (result.pauseForUserInput) {
      const q = result.visible?.find(
        (e: any) => e.type === "choice_questionnaire" || (e.type === "chat_text" && e.questionnaire)
      ) as any;
      const questionId = q?.type === "choice_questionnaire" ? q.questionId : q?.questionnaire?.questionId;
      const rawOptions = q?.type === "choice_questionnaire" ? q.content?.options : q?.questionnaire?.options;

      if (questionId) {
        this.memory.flowControl.pendingQuestion = {
          id: questionId,
          options: Array.isArray(rawOptions)
            ? rawOptions.map((o: any) => ({ id: o.id, label: o.label }))
            : [],
        };
        await this.persist();
      }

      await this.sendEvent({ type: "done" });
      await this.cleanup();
      return;
    }

    if (this.memory.flowControl.pendingTasks.length > 0) {
      await this.runNextStep();
    } else {
      await this.flushAssistantHistory();
      await this.sendEvent({ type: "done" });
      await this.cleanup();
    }
  }

  /**
   * Called from the queue worker per-event as shots generate.
   * Returns { cancelled: true } if the user hit stop — queue worker should throw
   * to abort engine.run() immediately rather than generating more shots.
   */
  async appendJobEvents(jobId: string, events: ChatEvent[]): Promise<{ cancelled: boolean }> {
    // Check cancellation flag first — skip storage/stream work if cancelled
    const cancelled = (await this.ctx.storage.get<boolean>(`job:${jobId}:cancelled`)) ?? false;
    if (cancelled) return { cancelled: true };

    // Always persist for durability / polling fallback
    const existing = await this.ctx.storage.get<ChatEvent[]>(`job:${jobId}:events`) ?? [];
    await this.ctx.storage.put(`job:${jobId}:events`, [...existing, ...events]);

    // Forward to open SSE stream (the no-polling fast path)
    if (this.writer) {
      for (const event of events) {
        await this.sendEvent(event);
      }
    }

    return { cancelled: false };
  }

  /**
   * Polling endpoint for async jobs (image gen, video gen).
   * Returns stored events once the job is complete.
   */
  async pollJobResult(jobId: string): Promise<{ status: string; events: ChatEvent[] }> {
    const status = (await this.ctx.storage.get<string>(`job:${jobId}:status`)) ?? "pending";
    const events = (await this.ctx.storage.get<ChatEvent[]>(`job:${jobId}:events`)) ?? [];
    return { status, events };
  }

  async cancel(): Promise<{ success: boolean; message: string }> {
    if (!this.isLocked || !this.abortController) {
      return { success: false, message: "No active request to cancel." };
    }

    this.abortController.abort();
    this.isLocked = false;
    this.abortController = null;
    this.memory.flowControl.pendingTasks = [];

    // If a shoot queue job is running, write a cancellation flag.
    // The queue worker checks this flag via appendJobEvents and will throw to abort engine.run().
    const activeShootJobId = this.memory.flowControl.activeShootJobId;
    if (activeShootJobId) {
      await this.ctx.storage.put(`job:${activeShootJobId}:cancelled`, true);
      this.memory.flowControl.activeShootJobId = undefined;
    }

    if (this.writer) {
      try {
        await this.sendEvent({ type: "done" });
        await new Promise((r) => setTimeout(r, 100));
        await this.writer.close();
      } catch {}
      this.writer = null;
    }

    await this.persist();
    return { success: true, message: "Request cancelled successfully." };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORCHESTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  private async orchestrate(message: string, attachments: any[]): Promise<void> {
    try {
      // Phase 1: Resume if we were waiting for a user answer
      const pending = this.memory.flowControl.pendingQuestion;
      if (pending) {
        if (this.answerMatchesPending(message, attachments, pending)) {
          await this.extractAnswer(message);

          if (this.memory.flowControl.pendingTasks.length > 0) {
            await this.runNextStep();
            return;
          }
        } else {
          // Doesn't answer the pending question — don't force a low-confidence
          // extraction into memory (e.g. avatar_approval hijacking an unrelated
          // new message + attachment). Abandon the question AND its queued
          // deterministic resume (avatar_finalize / resume_shoot_planner) —
          // resuming a workflow the user has moved past would still be wrong —
          // and fall through to Phase 2 so IntentEngine sees the real message.
          // Deliberately skip extractAnswer(): its underlying state (useAvatar,
          // avatarPrefs, etc.) stays untouched, so the gate just asks again
          // naturally if reached later.
          console.warn(`[Orchestrator] Message did not match pending question "${pending.id}" — abandoning it.`);
          this.memory.flowControl.pendingQuestion = null;
          this.memory.flowControl.pendingTasks = [];
          await this.persist();
        }
      }

      // Phase 2: Analyze intent
      await this.sendEvent({ type: "chat_text", status: "Analyzing your request..." });

      const catalog = getStandardToolCatalog(this.env as any, this.textService);
      const plannerAgent = new PlannerIntentAgent(this.textService, catalog);

      const plan: IntentPlan = await plannerAgent.analyze(message, {
        brandContext: this.brandContext,
        memory: this.memory,
        attachments,
      });

      // Apply safe state update from intent engine
      // Never let it overwrite product — that's resolveAttachments' job
      if (plan.hidden_state_update) {
        const { product: _ignored, ...safeUpdate } = plan.hidden_state_update as any;
        this.memory = deepMerge(this.memory, safeUpdate);
      }

      // Stream intent response to user
      if (plan.user_visible_response) {
        this.history.push({ role: "assistant", content: plan.user_visible_response });
        await this.sendEvent({ type: "chat_text", ai: plan.user_visible_response });
      }

      this.currentInput = { message };

      // Load task queue
      this.memory.flowControl.pendingTasks = plan.tasks.map((t, i) => ({
        id: t.id ?? `task-${Date.now()}-${i}`,
        tool: t.tool,
        input: t.input,
      }));

      await this.persist();

      // Phase 3: Execute
      await this.runNextStep();

    } catch (err: any) {
      console.error("[Orchestrator] Orchestration error:", err);
      await this.sendEvent({ type: "error", message: err.message });
      await this.cleanup();
    }
  }

  /**
   * (Re-)arms the hung-tool safety net. Called once when a turn starts and
   * again at the top of every runNextStep() — each sync tool step gets its
   * own fresh 90s window rather than sharing one budget across a whole
   * multi-step chain. A rich request (storyteller -> creative_studio ->
   * avatar_generator -> image generation) can legitimately take a few
   * minutes combined without any single step actually hanging; this only
   * needs to catch a step that's individually stuck.
   */
  // 3 minutes — generous enough to cover a slow step that's legitimately retrying
  // (e.g. TextService.generate()'s own internal retries on a sluggish image-gen
  // call can take up to ~3 min worst case: 3 attempts x 60s + backoff) without
  // being so long that a truly hung step leaves the user waiting forever.
  private static readonly STEP_TIMEOUT_MS = 180_000;

  private armLockTimeout(): void {
    if (this.lockTimeout) clearTimeout(this.lockTimeout);
    this.lockTimeout = setTimeout(async () => {
      if (this.isLocked) {
        console.error(`[Orchestrator] Lock timeout — forcing cleanup after ${Orchestrator.STEP_TIMEOUT_MS / 1000}s on one step`);
        await this.sendEvent({ type: 'error', message: 'Request timed out' });
        await this.cleanup();
      }
    }, Orchestrator.STEP_TIMEOUT_MS);
  }

  private async runNextStep(): Promise<void> {
    if (this.abortController?.signal.aborted) {
      await this.cleanup();
      return;
    }

    if (this.memory.flowControl.pendingTasks.length === 0) {
      await this.flushAssistantHistory();
      await this.sendEvent({ type: "done" });
      await this.cleanup();
      return;
    }

    this.armLockTimeout();

    const task = this.memory.flowControl.pendingTasks.shift()!;
    const ctx = this.buildToolContext();

    // Structured tools (generate_text, generate_image, search) are meant to be
    // called with explicit input from the plan/chain; fall back to the turn's
    // raw input only when nothing more specific was provided.
    const resolveInput = () =>
      task.input && Object.keys(task.input).length > 0 ? task.input : this.currentInput;

    // ── Sync fast-path tools ───────────────────────────────────────────────
    // These run directly inside the DO — no queue needed
    const syncTools: Record<string, () => Promise<ToolResponse>> = {
      memory_recall: async () => {
        const { MemoryTool } = await import("../tools/memory");
        return new MemoryTool(this.env as any)
          .run({ query: task.input?.query ?? this.currentInput?.message ?? "" }, ctx);
      },
      creative_studio: async () => {
        await this.sendEvent({ type: "chat_text", status: "Planning creative direction..." });
        return new CreativeStudioTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      storyteller: async () => {
        await this.sendEvent({ type: "chat_text", status: "Building brand narrative..." });
        return new StorytellerTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      avatar_generator: async () => {
        await this.sendEvent({ type: "chat_text", status: "Designing model personas..." });
        return new AvatarGeneratorTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      generate_text: async () => {
        const { GenerateTextTool } = await import("../tools/generateText");
        return new GenerateTextTool().run(resolveInput(), ctx);
      },
      generate_image: async () => {
        await this.sendEvent({ type: "chat_text", status: "Generating image..." });
        const { GenerateImageTool } = await import("../tools/generateImage");
        return new GenerateImageTool(this.env as any).run(resolveInput(), ctx);
      },
      search: async () => {
        const { SearchTool } = await import("../tools/search");
        return new SearchTool(this.env as any).run(resolveInput(), ctx);
      },
      shoot_engine_planner: async () => {
        await this.sendEvent({ type: "chat_text", status: "Preparing campaign shoot plan..." });
        const { PhotoshootAgent } = await import("../agents/PhotoshootAgent");
        return new PhotoshootAgent(this.env as any).run(this.currentInput, ctx);
      },
    };

    if (syncTools[task.tool]) {
      const result = await syncTools[task.tool]();
      await this.handleToolResult(task.tool, result);
      return;
    }

    // ── ShootEngine / SimpleShootEngine — queued, but SSE stays open ─────────
    // Queue does the heavy lifting (retries, rate limiting).
    // appendJobEvents RPC forwards each shot back through this writer in real-time.
    // Client sees a single stream — no polling needed. Which engine actually runs
    // is decided by the queue worker's switch on task.tool (index.ts).
    if (task.tool === 'shoot_engine' || task.tool === 'simple_shoot_engine') {
      // Clear 90s timeout — shoot gen takes several minutes
      if (this.lockTimeout) {
        clearTimeout(this.lockTimeout);
        this.lockTimeout = null;
      }
      const jobId = crypto.randomUUID();
      await this.ctx.storage.put(`job:${jobId}:status`, 'pending');
      await this.ctx.storage.put(`job:${jobId}:events`, [] as ChatEvent[]);
      await this.ctx.storage.put(`job:${jobId}:pendingCount`, 1);

      // Track so cancel() can signal the queue worker to stop
      this.memory.flowControl.activeShootJobId = jobId;
      await this.persist();

      const taskInput = task.input && Object.keys(task.input).length > 0
        ? task.input
        : this.currentInput;
      // Stream stays open — appendJobEvents will push events as they arrive
      await this.enqueueTask(task, taskInput, jobId);
      return;
    }

    // ── Async slow path (queued jobs — video gen etc.) ────────────────────────
    //   1. Send a "queued" event so the client knows to switch to polling
    //   2. Close the stream and release the lock immediately
    //   3. Queue ALL remaining tasks at once (no serial waiting)
    //   4. Results accumulate in DO storage; client polls /chat/jobs/:jobId
    const jobId = crypto.randomUUID();
    const remainingTasks = [...this.memory.flowControl.pendingTasks];
    this.memory.flowControl.pendingTasks = [];
    await this.persist();

    const totalTaskCount = 1 + remainingTasks.length;
    await this.ctx.storage.put(`job:${jobId}:status`, "pending");
    await this.ctx.storage.put(`job:${jobId}:events`, [] as ChatEvent[]);
    await this.ctx.storage.put(`job:${jobId}:pendingCount`, totalTaskCount);

    await this.sendEvent({ type: "queued", jobId, sessionId: this.sessionKey });
    await this.cleanup(); // releases lock, closes stream, clears timers

    // Enqueue current task + all remaining in one go
    const taskInput = task.input && Object.keys(task.input).length > 0
      ? task.input
      : this.currentInput;
    await this.enqueueTask(task, taskInput, jobId);

    for (const remaining of remainingTasks) {
      const rInput = remaining.input && Object.keys(remaining.input).length > 0
        ? remaining.input
        : this.currentInput;
      await this.enqueueTask(remaining, rInput, jobId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT & STATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Hydrates in-memory state from DO storage.
   * Called after hibernation — safe to call multiple times.
   */
  private async ensureHydrated(): Promise<void> {
    if (this.initialized) return;

    const [memory, history, brandContext, userId, sessionKey] = await Promise.all([
      this.ctx.storage.get<SessionMemory>("memory"),
      this.ctx.storage.get<any[]>("history"),
      this.ctx.storage.get<any>("brandContext"),
      this.ctx.storage.get<string>("userId"),
      this.ctx.storage.get<string>("sessionKey"),
    ]);

    this.memory = memory ?? {
      conversation: { answeredQuestions: [] },
      flowControl: { pendingQuestion: null, pendingTasks: [] },
    };
    this.history = history ?? [];
    this.brandContext = brandContext ?? {};
    this.userId = userId ?? "";
    this.sessionKey = sessionKey ?? "";
    this.initialized = true;
  }

  /**
   * Loads prior messages and assets for this project from the DB.
   * Called once during first session init — gives the DO full project context.
   */
  private async loadProjectHistory(
    projectId?: string,
    userId?: string
  ): Promise<void> {
    if (!projectId || !userId) return;

    const db = getDb(this.env.DATABASE_URL);

    try {
      // Load last 50 messages for this project — enough context without overloading
      const messages = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.projectId, projectId))
        .orderBy(asc(chatMessages.createdAt))
        .limit(50);

      if (messages.length > 0) {
        this.history = messages.map((m) => ({
          role: m.sender === "user" ? "user" : "assistant",
          content: m.content,
        }));
        console.log(
          `[Orchestrator] Loaded ${messages.length} prior messages for project ${projectId}`
        );
      }

      // Load any existing product assets for this project
      // This means if the user uploaded a product 3 sessions ago,
      // this session still knows about it
      const existingAssets = await db
        .select()
        .from(userAssets)
        .where(eq(userAssets.projectId, projectId))
        .limit(5);

      if (existingAssets.length > 0) {
        await this.lockProductFromAssets(
          existingAssets.map((a) => ({ ...a, r2Key: a.url })),
          existingAssets.map((a) => a.id)
        );
        console.log(
          `[Orchestrator] Pre-loaded product from ${existingAssets.length} project assets`
        );
      }
    } catch (err) {
      // Non-fatal — session still works without prior history
      console.error("[Orchestrator] Failed to load project history:", err);
    }
  }

  /**
   * Saves a single message to the DB.
   * Called immediately — doesn't wait for the full response.
   */
  private async saveMessageToDB(
    content: string,
    sender: "user" | "assistant"
  ): Promise<void> {
    if (!this.memory.projectId || !this.userId) return;

    const db = getDb(this.env.DATABASE_URL);
    try {
      await db.insert(chatMessages).values({
        id: crypto.randomUUID(),
        projectId: this.memory.projectId,
        userId: this.userId,
        content,
        sender,
        type: "text",
        createdAt: new Date(),
      });
    } catch (err) {
      // Non-fatal — in-memory history still works even if DB write fails
      console.error("[Orchestrator] Failed to save message to DB:", err);
    }
  }

  /**
   * Flushes any assistant messages from this turn to the DB.
   * Called at the end of a complete turn (done event).
   */
  private async flushAssistantHistory(): Promise<void> {
    // Collect assistant messages added this turn
    const assistantMessages = this.history
      .filter((h) => h.role === "assistant" && !h.persisted)
      .map((h) => h.content)
      .join("\n");

    if (assistantMessages.trim()) {
      await this.saveMessageToDB(assistantMessages, "assistant");
      // Mark as persisted so we don't double-save
      this.history = this.history.map((h) =>
        h.role === "assistant" ? { ...h, persisted: true } : h
      );
    }
  }

  private buildToolContext(): ToolContext {
    return {
      memory: this.memory,
      brandContext: this.brandContext,
      history: this.history,
      attachments: this.attachments,
      userId: this.userId,
      sessionId: this.sessionKey,
      // Shared service — not reconstructed per tool
      textService: this.textService,
    };
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put({
      memory: this.memory,
      history: this.history,
      brandContext: this.brandContext,
      userId: this.userId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENT RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  private async resolveAttachments(attachments: any[]): Promise<void> {
    const db = getDb(this.env.DATABASE_URL);
    const thisTurnAssetIds = attachments.map((a) => a.assetId).filter(Boolean);

    const alreadyLocked = this.memory.product?.productLocked === true;
    const lockedAssetIds = new Set(this.memory.product?.assetIds ?? []);
    // A genuinely new attachment this turn — one whose assetId isn't already
    // part of the locked product. Re-sending the same asset, or no attachment
    // at all, must NOT re-trigger resolution (unchanged single-lock behavior).
    const hasNewThisTurnAsset = thisTurnAssetIds.some((id) => !lockedAssetIds.has(id));

    if (alreadyLocked && !hasNewThisTurnAsset) return;

    // Priority 1: this turn's attachments — runs even when already locked, IF
    // there's a genuinely new asset id. Previously this whole method returned
    // before ever reaching this block once locked, silently dropping any
    // later upload the user explicitly attached ("use this instead").
    if (thisTurnAssetIds.length) {
      const previousAssetIds = [...lockedAssetIds];

      const userResults = await db
        .select()
        .from(userAssets)
        .where(inArray(userAssets.id, thisTurnAssetIds));

      if (userResults.length) {
        await this.lockProductFromAssets(
          userResults.map((a) => ({ ...a, r2Key: a.url })),
          thisTurnAssetIds
        );
        this.maybeResetShootGatesOnProductChange(previousAssetIds);
        return;
      }

      const privateResults = await db
        .select()
        .from(privateAssets)
        .where(inArray(privateAssets.id, thisTurnAssetIds));

      if (privateResults.length) {
        await this.lockProductFromAssets(privateResults, thisTurnAssetIds);
        this.maybeResetShootGatesOnProductChange(previousAssetIds);
        return;
      }

      if (alreadyLocked) {
        // New id(s) didn't resolve in either table (bad id, deleted row,
        // etc.) — fall back to the existing locked product rather than
        // error. Can't stream a warning from here — this runs in process()
        // before the SSE writer exists.
        console.warn("[Orchestrator] New attachment(s) did not resolve — keeping existing locked product:", thisTurnAssetIds);
        return;
      }
      // Not locked yet — fall through to Priority 2/3 below (unchanged).
    }

    if (alreadyLocked) return; // no resolvable new attachment — don't run the
                                // first-lock-only fallbacks against a locked product

    // Priority 2: memory refs from prior turns
    const memoryRefs =
      this.memory.conversation?.assetRefs?.filter(
        (a: any) => a.role === "product"
      ) ?? [];

    if (memoryRefs.length) {
      const primary = memoryRefs[0];
      this.memory.product = {
        ...this.memory.product,
        productLocked: true,
        primaryAssetKey: primary.r2Key,
        primaryAssetId: primary.assetId,
        name: primary.label,
        colors: primary.colors ?? [],
        tags: primary.tags ?? [],
      };
      await this.persist();
      return;
    }

    // Priority 3: DB by projectId (already loaded by loadProjectHistory,
    // but this catches the case where resolveAttachments runs before init)
    if (this.memory.projectId) {
      const uploads = await db
        .select()
        .from(userAssets)
        .where(eq(userAssets.projectId, this.memory.projectId))
        .limit(5);

      if (uploads.length) {
        await this.lockProductFromAssets(
          uploads.map((a) => ({ ...a, r2Key: a.url })),
          uploads.map((a) => a.id)
        );
      }
    }
  }

  // When a genuinely new product asset replaces the locked one mid-session,
  // the prior shoot confirmation (asset list + count) no longer reflects
  // reality — reset the resettable per-shoot gate flags so
  // SimpleShootPlannerTool's Gate 4 re-confirms with the new asset instead of
  // silently reusing a stale confirmation. Does NOT touch
  // avatarImages/avatarApproved — avatars are a reusable, user-level asset by
  // design (see the avatar_reuse gate), not tied 1:1 to a single product.
  private maybeResetShootGatesOnProductChange(previousAssetIds: string[]): void {
    if (previousAssetIds.length === 0) return; // first-time lock, nothing to reset
    this.memory.campaign = {
      ...this.memory.campaign,
      shootConfirmed: false,
      shootEngineQueued: false,
    };
  }

  private async lockProductFromAssets(
    assets: any[],
    assetIds: string[]
  ): Promise<void> {
    const primary = assets[0];
    const parsedData = primary.parsedData as any;

    this.memory.product = {
      ...this.memory.product,
      productLocked: true,
      primaryAssetKey: primary.r2Key,
      primaryAssetId: primary.id,
      assetIds,
      name:
        parsedData?.name ||
        parsedData?.label ||
        primary.r2Key?.split("/").pop() ||
        "product",
      colors: (primary.colors as string[]) ?? [],
      tags: (primary.tags as string[]) ?? [],
      description: parsedData?.description ?? "",
    };

    this.memory.conversation = {
      ...this.memory.conversation,
      assetRefs: [
        ...(this.memory.conversation?.assetRefs ?? []).filter(
          (r: any) => r.role !== "product"
        ),
        ...assets.map((a) => ({
          assetId: a.id,
          r2Key: a.r2Key,
          label: (a.parsedData as any)?.name ?? "uploaded asset",
          role: "product" as const,
          mimeType: a.mimeType ?? "image/jpeg",
          colors: (a.colors as string[]) ?? [],
          tags: (a.tags as string[]) ?? [],
        })),
      ],
    };

    await this.persist();
    console.log(
      `[Orchestrator] Product locked: "${this.memory.product.name}" | key: ${this.memory.product.primaryAssetKey}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANSWER EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

  // True if `message`/`attachments` plausibly answers `pending`. False means:
  // don't touch memory for this question — abandon it and treat the turn as a
  // fresh request instead of forcing a low-confidence extraction.
  private answerMatchesPending(
    message: string,
    attachments: any[],
    pending: { id: string; options?: Array<{ id: string; label: string }> }
  ): boolean {
    if (pending.options === undefined) return true; // legacy session, old behavior
    if (pending.options.length === 0) return attachments.length === 0; // free-text gate
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    const m = norm(message);
    return pending.options.some((o) => norm(o.id) === m || norm(o.label) === m);
  }

  private async extractAnswer(message: string): Promise<void> {
    const pending = this.memory.flowControl.pendingQuestion;
    if (!pending) return;

    const EXTRACTORS: Record<string, (msg: string) => Partial<SessionMemory>> = {
      product_source: (v) => ({
        product: {
          ...this.memory.product,
          source: v,
          productLocked: true, // Always lock after user answers to prevent repeated questions
        },
      }),
      brand_vibe: (v) => ({
        creative: {
          ...this.memory.creative,
          style: { ...this.memory.creative?.style, vibe: v },
        },
      }),
      avatar_choice: (v) => ({
        campaign: {
          ...this.memory.campaign,
          avatarChoice: v,
          useAvatar: v === "use_avatar",
        },
      }),
      avatar_prefs: (v) => ({
        campaign: { ...this.memory.campaign, avatarPrefs: v },
      }),
      avatar_custom_desc: (v) => ({
        campaign: { ...this.memory.campaign, avatarCustomDesc: v },
      }),
      asset_selection: (v) =>
        v === "__upload_new__"
          ? { product: { ...this.memory.product, source: "upload", productLocked: this.memory.product?.productLocked ?? false } }
          : {
              product: {
                ...this.memory.product,
                assetIds: [v],
                primaryAssetId: v,
                productLocked: true,
                source: "existing",
              },
            },
      shoot_brief_choice: (v) => ({
        campaign: { ...this.memory.campaign, shootBriefChoice: v },
      }),
      shoot_brief_custom: (v) => ({
        campaign: { ...this.memory.campaign, shootBrief: v },
      }),
      avatar_approval: (v) => ({
        campaign: { ...this.memory.campaign, avatarApproved: v === "approve" },
      }),
      avatar_reuse: (v) => {
        if (v === "__new__") {
          return { campaign: { ...this.memory.campaign, useAvatar: true } };
        }
        const saved = (this.memory.campaign?.savedAvatarsChoice ?? []).find((a: any) => a.id === v);
        return {
          campaign: {
            ...this.memory.campaign,
            useAvatar: true,
            avatarImages: saved?.images ?? this.memory.campaign?.avatarImages,
            savedAvatarsChoice: undefined,
          },
        };
      },
      shoot_confirm: (v) => {
        if (v === "change_assets") {
          return {
            product: { ...this.memory.product, assetIds: [], primaryAssetId: "", productLocked: false },
            conversation: { ...this.memory.conversation, assetRefs: [] },
            campaign: { ...this.memory.campaign, shootConfirmed: false },
          };
        }
        const count = parseInt(v, 10);
        return {
          campaign: {
            ...this.memory.campaign,
            shootConfirmed: true,
            shootCount: Number.isFinite(count) && count > 0 ? count : 1,
          },
        };
      },
    };

    const extractor = EXTRACTORS[pending.id];
    if (extractor) {
      this.memory = deepMerge(this.memory, extractor(message));
    }

    this.memory.conversation.answeredQuestions = [
      ...(this.memory.conversation.answeredQuestions ?? []),
      pending.id,
    ];
    this.memory.flowControl.pendingQuestion = null;
    await this.persist();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUEUE
  // ═══════════════════════════════════════════════════════════════════════════

  private async enqueueTask(task: Task, input: any, jobId?: string): Promise<void> {
    const job = {
      sessionId: this.ctx.id.toString(),
      userId: this.userId,
      tool: task.tool,
      input,
      jobId, // tells handleToolResult to store results instead of streaming
      brandContext: this.brandContext,
      memory: this.memory,
      history: this.history,
      createdAt: Date.now(),
    };

    const queueMap: Record<string, Queue> = {
      video_generator: this.env.VIDEO_QUEUE,
    };

    const queue = queueMap[task.tool] ?? this.env.LLM_QUEUE;
    await queue.send(job);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STREAM
  // ═══════════════════════════════════════════════════════════════════════════

  private async sendEvent(event: ChatEvent): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.write(
        this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
      );
    } catch {
      console.error("[Orchestrator] Stream write failed — client may have disconnected.");
    }
  }

  private async cleanup(): Promise<void> {
    this.isLocked = false;
    this.abortController = null;

    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.writer) {
      try { await this.writer.close(); } catch {}
      this.writer = null;
    }
  }
}
