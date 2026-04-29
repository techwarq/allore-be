import { DurableObject } from "cloudflare:workers";
import { IntentEngine, IntentPlan } from "../services/chat/IntentEngine";
import { ChatEvent, Task, ToolResponse, SessionMemory } from "../types/chat";
import { ToolContext } from "../services/chat/tools/Tool";
import { getDb } from "../db";
import { privateAssets, assets as userAssets, chatMessages } from "../db/schema";
import { inArray, eq, asc } from "drizzle-orm";
import { TextService } from "../services/gemini/TextService";
import { getStandardToolCatalog } from "../services/chat/StandardTools";
import { CreativeStudioTool } from "../services/chat/tools/CreativeStudioTool";
import { StorytellerTool } from "../services/chat/tools/StorytellerTool";
import { PhotoshootPlannerTool } from "../services/chat/tools/PhotoshootPlannerTool";
import { AvatarGeneratorTool } from "../services/chat/tools/AvatarGeneratorTool";

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

export interface ResponserEnv {
  GEMINI_API_KEY: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  DATABASE_URL: string;
  API_URL: string;
  LLM_QUEUE: Queue;
  IMAGE_QUEUE: Queue;
  VIDEO_QUEUE: Queue;
  ASSETS_BUCKET: R2Bucket;
}

export class Responser extends DurableObject<ResponserEnv> {

  // ── In-memory state (rebuilt from storage after hibernation) ──────────────
  private initialized = false;
  private memory: SessionMemory = {
    conversation: { answeredQuestions: [] },
    flowControl: { pendingQuestion: null, pendingTasks: [] },
  };
  private history: any[] = [];
  private brandContext: any = {};
  private userId = "";
  private attachments: any[] = [];

  // ── Execution state ────────────────────────────────────────────────────────
  private isLocked = false;
  private currentInput: any = {};
  private activeAsyncJobs = 0;
  private abortController: AbortController | null = null;

  // ── Stream state ───────────────────────────────────────────────────────────
  private writer: WritableStreamDefaultWriter | null = null;
  private encoder = new TextEncoder();
  private heartbeatInterval: any = null;

  // ── Shared services (built once, reused across tools) ─────────────────────
  private textService!: TextService;

  constructor(state: DurableObjectState, env: ResponserEnv) {
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
    projectId?: string
  ): Promise<void> {
    const storedUserId = await this.ctx.storage.get<string>("userId");

    if (this.initialized || storedUserId) {
      // Session already exists — refresh brand context and ensure memory is hydrated
      await this.ensureHydrated();
      this.brandContext = brandContext;

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
      this.initialized = true;
      return;
    }

    // First time — seed the session
    this.brandContext = brandContext;
    this.userId = userId;
    if (projectId) this.memory.projectId = projectId;

    // Load prior history from DB for this project
    // This is the key change: we load ALL prior messages for this project
    // so the DO has full context even on first boot
    await this.loadProjectHistory(projectId, userId);

    await this.ctx.storage.put({
      brandContext,
      userId,
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

    // Heartbeat — keeps SSE alive through Cloudflare's idle timeout
    this.heartbeatInterval = setInterval(() => {
      this.sendEvent({ type: "status", content: " " }).catch(() => {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      });
    }, 15_000);

    // All orchestration runs in waitUntil — non-blocking
    this.ctx.waitUntil(this.orchestrate(message, attachments));

    return readable;
  }

  /**
   * Called by queue workers when an async tool finishes.
   * This is the RPC callback — must re-hydrate if DO hibernated.
   */
  async handleToolResult(tool: string, result: ToolResponse): Promise<void> {
    // DO may have hibernated between enqueue and callback — re-hydrate
    await this.ensureHydrated();

    if (this.abortController?.signal.aborted) return;

    // 1. Merge memory update
    if (result.memoryUpdate) {
      this.memory = deepMerge(this.memory, result.memoryUpdate);
    }

    // 2. Inject next tasks if tool requested them
    if (result.nextTasks?.length) {
      this.memory.flowControl.pendingTasks.unshift(...result.nextTasks);
    }

    // 3. Stream visible events to client
    for (const event of result.visible ?? []) {
      // Explicit history append — not a side effect of sendEvent
      if (event.type === "text") {
        this.history.push({ role: "assistant", content: (event as any).content });
      }
      await this.sendEvent(event);
    }

    // 4. Update currentInput for the next tool
    if (result.nextInput) {
      this.currentInput = result.nextInput;
    }

    // 5. Flush everything to storage
    await this.persist();

    // 6. Pause check — tool asked to wait for user
    if (result.pauseForUserInput) {
      const q = result.visible?.find(
        (e: any) => e.type === "choice_questionnaire" || e.type === "questionnaire"
      ) as any;

      if (q?.questionId) {
        this.memory.flowControl.pendingQuestion = { id: q.questionId };
        await this.persist();
      }

      await this.sendEvent({ type: "done" });
      await this.cleanup();
      return;
    }

    // 7. Continue or finish
    if (
      this.memory.flowControl.pendingTasks.length > 0 ||
      this.activeAsyncJobs > 0
    ) {
      await this.runNextStep();
    } else {
      // All done — save final assistant message to DB
      await this.flushAssistantHistory();
      await this.sendEvent({ type: "done" });
      await this.cleanup();
    }
  }

  async cancel(): Promise<{ success: boolean; message: string }> {
    if (!this.isLocked || !this.abortController) {
      return { success: false, message: "No active request to cancel." };
    }

    this.abortController.abort();
    this.isLocked = false;
    this.abortController = null;
    this.memory.flowControl.pendingTasks = [];

    if (this.writer) {
      try {
        await this.sendEvent({ type: "done" });
        await new Promise((r) => setTimeout(r, 100));
        await this.writer.close();
      } catch {}
      this.writer = null;
    }

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
        await this.extractAnswer(message);

        if (this.memory.flowControl.pendingTasks.length > 0) {
          await this.runNextStep();
          return;
        }
      }

      // Phase 2: Analyze intent
      await this.sendEvent({ type: "status", content: "Analyzing your request..." });

      const catalog = getStandardToolCatalog(this.env as any, this.textService);
      const intentEngine = new IntentEngine(this.textService, catalog);

      const plan: IntentPlan = await intentEngine.analyze(message, {
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
        await this.sendEvent({ type: "text", content: plan.user_visible_response });
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
      console.error("[Responser] Orchestration error:", err);
      await this.sendEvent({ type: "error", message: err.message });
      await this.cleanup();
    }
  }

  private async runNextStep(): Promise<void> {
    if (this.abortController?.signal.aborted) {
      await this.cleanup();
      return;
    }

    if (
      this.memory.flowControl.pendingTasks.length === 0 &&
      this.activeAsyncJobs === 0
    ) {
      await this.flushAssistantHistory();
      await this.sendEvent({ type: "done" });
      await this.cleanup();
      return;
    }

    if (this.memory.flowControl.pendingTasks.length === 0) return;

    const task = this.memory.flowControl.pendingTasks.shift()!;
    const ctx = this.buildToolContext();

    // ── Sync fast-path tools ───────────────────────────────────────────────
    // These run directly inside the DO — no queue needed
    const syncTools: Record<string, () => Promise<ToolResponse>> = {
      creative_studio: async () => {
        await this.sendEvent({ type: "status", content: "Planning creative direction..." });
        return new CreativeStudioTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      storyteller: async () => {
        await this.sendEvent({ type: "status", content: "Building brand narrative..." });
        return new StorytellerTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      photoshoot_planner: async () => {
        await this.sendEvent({ type: "status", content: "Building photoshoot plan..." });
        return new PhotoshootPlannerTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
      avatar_generator: async () => {
        await this.sendEvent({ type: "status", content: "Designing model personas..." });
        return new AvatarGeneratorTool(this.textService, this.env as any)
          .run(this.currentInput, ctx);
      },
    };

    if (syncTools[task.tool]) {
      const result = await syncTools[task.tool]();
      await this.handleToolResult(task.tool, result);
      return;
    }

    // ── Image sequential expansion ─────────────────────────────────────────
    // Expand plannedShots into individual tasks so each image streams as soon
    // as it's ready instead of waiting for the whole batch.
    if (task.tool === "photoshoot_generator" && !task.input?.shot) {
      const shots = this.memory.plannedShots ?? [];

      if (shots.length === 0) {
        await this.sendEvent({
          type: "status",
          content: "No planned shots found. Skipping generation.",
        });
        await this.runNextStep();
        return;
      }

      await this.sendEvent({
        type: "status",
        content: `Generating ${shots.length} shots...`,
      });

      this.memory.flowControl.pendingTasks.unshift(
        ...shots.map((shot: any) => ({
          id: `shot-${shot.id}`,
          tool: "photoshoot_generator" as const,
          input: { shot, projectId: this.memory.projectId },
        }))
      );
      await this.persist();
      await this.runNextStep();
      return;
    }

    // ── Default slow path ──────────────────────────────────────────────────
    const taskInput = task.input && Object.keys(task.input).length > 0
      ? task.input
      : this.currentInput;
    await this.enqueueTask(task, taskInput);
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

    const [memory, history, brandContext, userId] = await Promise.all([
      this.ctx.storage.get<SessionMemory>("memory"),
      this.ctx.storage.get<any[]>("history"),
      this.ctx.storage.get<any>("brandContext"),
      this.ctx.storage.get<string>("userId"),
    ]);

    this.memory = memory ?? {
      conversation: { answeredQuestions: [] },
      flowControl: { pendingQuestion: null, pendingTasks: [] },
    };
    this.history = history ?? [];
    this.brandContext = brandContext ?? {};
    this.userId = userId ?? "";
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
          `[Responser] Loaded ${messages.length} prior messages for project ${projectId}`
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
          `[Responser] Pre-loaded product from ${existingAssets.length} project assets`
        );
      }
    } catch (err) {
      // Non-fatal — session still works without prior history
      console.error("[Responser] Failed to load project history:", err);
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
      console.error("[Responser] Failed to save message to DB:", err);
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
    if (this.memory.product?.productLocked) return;

    const db = getDb(this.env.DATABASE_URL);

    // Priority 1: this turn's attachments
    const assetIds = attachments.map((a) => a.assetId).filter(Boolean);
    if (assetIds.length) {
      const userResults = await db
        .select()
        .from(userAssets)
        .where(inArray(userAssets.id, assetIds));

      if (userResults.length) {
        await this.lockProductFromAssets(
          userResults.map((a) => ({ ...a, r2Key: a.url })),
          assetIds
        );
        return;
      }

      const privateResults = await db
        .select()
        .from(privateAssets)
        .where(inArray(privateAssets.id, assetIds));

      if (privateResults.length) {
        await this.lockProductFromAssets(privateResults, assetIds);
        return;
      }
    }

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
      `[Responser] Product locked: "${this.memory.product.name}" | key: ${this.memory.product.primaryAssetKey}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANSWER EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

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

  private async enqueueTask(task: Task, input: any): Promise<void> {
    const job = {
      sessionId: this.ctx.id.toString(),
      userId: this.userId,
      tool: task.tool,
      input,
      brandContext: this.brandContext,
      memory: this.memory,
      history: this.history,
      createdAt: Date.now(),
    };

    const queueMap: Record<string, Queue> = {
      storyteller:        this.env.LLM_QUEUE,
      creative_studio:    this.env.LLM_QUEUE,
      photoshoot_planner: this.env.LLM_QUEUE,
      photoshoot_generator: this.env.IMAGE_QUEUE,
      video_generator:    this.env.VIDEO_QUEUE,
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
      console.error("[Responser] Stream write failed — client may have disconnected.");
    }
  }

  private async cleanup(): Promise<void> {
    this.isLocked = false;
    this.abortController = null;

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
