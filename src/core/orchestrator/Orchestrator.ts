import { DurableObject } from "cloudflare:workers";
import { PlannerIntentAgent, IntentPlan } from "../agents/PlannerIntentAgent";
import { ChatEvent, Task, ToolResponse, SessionMemory } from "../../types/chat";
import { ToolContext } from "../../services/chat/tools/Tool";
import { getDb } from "../../db";
import { privateAssets, assets as userAssets, chatMessages } from "../../db/schema";
import { inArray, eq, asc } from "drizzle-orm";
import { ITextService } from "../../services/chat/ITextService";
import { OpenRouterTextService, OPENROUTER_MODELS } from "../ai-models/openrouter/OpenRouterTextService";
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
  // Vibe-picker gate (SimpleShootPlannerTool Gate 1a, via PhotoshootAgent) —
  // real Pinterest reference images for the shoot.
  PINTEREST_COOKIE?: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL";
  PINTEREST_EMAIL?: string;
  PINTEREST_PASSWORD?: string;
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
  // Failsafe for queued shoot jobs (shoot_engine/simple_shoot_engine): those
  // clear lockTimeout entirely (see runNextStep) since generation can take
  // several minutes, so a queue message that's silently dropped or never
  // delivered (queue misconfig, worker crash mid-processing, lost RPC) leaves
  // the session locked and the client's SSE stream open with nothing ever
  // arriving — an infinite spinner the user can only escape by hitting stop.
  // This is a last-resort timer, separate from lockTimeout, keyed by jobId so
  // a real completion (handleToolResult) can disarm it before it fires.
  private jobWatchdogs: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Generous: worst case is ~3 shots x 3 retry attempts x ~120s Fal poll
  // deadline each (see SimpleShootEngine.generateShotWithRetry), plus the
  // creative-direction/prompt-compiling LLM stages before generation starts.
  private static readonly JOB_WATCHDOG_MS = 20 * 60 * 1000;

  // ── Shared services (built once, reused across tools) ─────────────────────
  // Chat text reasoning (intent planning, storyteller, creative_studio, avatar
  // casting) runs on OpenRouter/qwen — see prepareTurn(). Typed as the provider-
  // agnostic ITextService so the engine can be swapped without touching tools.
  // Image generation (avatar/photoshoot) does NOT go through this — those tools
  // build their own Gemini service, since qwen is text-only.
  private textService!: ITextService;

  // ── Mutation serialization ─────────────────────────────────────────────────
  // A DO instance isn't automatically mutually-exclusive across concurrent RPCs —
  // execution interleaves at every `await`. A background orchestrate() call
  // (kicked off via waitUntil in process()) can still be mid-flight, awaiting an
  // LLM call, when a queue worker's handleToolResult()/appendJobEvents() RPC lands
  // for the same session. Both read-modify-write this.memory/this.history; without
  // serialization the later write silently clobbers the earlier one (e.g. a
  // finished tool's result vanishes, or a resolved question gets asked again).
  // Every RPC that mutates that state is routed through this queue so they run
  // one at a time, in arrival order, regardless of how their internal awaits
  // interleave.
  private mutationQueue: Promise<unknown> = Promise.resolve();

  private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

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
    return this.enqueueMutation(() =>
      this._setContext(brandContext, userId, projectId, sessionKey)
    );
  }

  private async _setContext(
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

      // persist() is the single place that writes memory/history/brandContext/
      // userId/sessionKey — one batched storage.put() instead of three separate
      // ones, so a mid-write crash can't leave them inconsistent.
      await this.persist();
      this.initialized = true;
      return;
    }

    // First time — seed the session
    this.brandContext = brandContext;
    this.userId = userId;
    this.sessionKey = sessionKey ?? "";
    if (projectId) this.memory.projectId = projectId;

    await this.loadProjectHistory(projectId, userId);
    await this.persist();
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

    // Everything that reads/writes this.memory/this.history for this turn's setup
    // is queued as one unit — this way it can't interleave with a still-running
    // background orchestrate() or a late handleToolResult()/cancel() callback
    // from a previous turn's async job.
    await this.enqueueMutation(() => this.prepareTurn(message, attachments));

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

    // All orchestration runs in waitUntil — non-blocking. Queued as its own unit
    // (separate from prepareTurn's) so it still serializes against any
    // handleToolResult()/appendJobEvents()/cancel() RPC that lands while it's
    // mid-flight, without making process() itself wait for it to finish.
    this.ctx.waitUntil(
      this.enqueueMutation(() => this.orchestrate(message, attachments))
    );

    return readable;
  }

  /**
   * Turn setup: hydrate, persist the user message, resolve attachments/product.
   * Always run inside enqueueMutation — see the mutationQueue comment above.
   */
  private async prepareTurn(message: string, attachments: any[]): Promise<void> {
    await this.ensureHydrated();

    // Build the shared chat-text engine once per request. All chat reasoning
    // steps (intent, storyteller, creative_studio, avatar casting) run on
    // OpenRouter qwen 3.7 flash — NOT Gemini. Tools receive this via their
    // constructor / ToolContext and call generateText() on it.
    this.textService = new OpenRouterTextService(this.env.OPENROUTER_API_KEY!, {
      model: OPENROUTER_MODELS.QWEN_3_7_FLASH,
    });

    // Save user message to DB immediately
    // This persists even if the DO crashes mid-execution
    await this.saveMessageToDB(message, "user");

    // Append to in-memory history
    this.history.push({ role: "user", content: message });
    await this.persist();

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
  }

  /**
   * Dev/debug escape hatch — clears the shoot-flow flags directly, for sessions
   * that got stuck stranded before the reset-on-completion fix existed (or any
   * future case where a job never calls back), OR sessions whose brief/vibe
   * fields were set before the job-completion reset covered those fields too
   * (they'll otherwise stay stuck "answered" for the rest of the session — see
   * the memoryUpdate in index.ts's queue consumer for the normal reset path).
   * Not part of the normal request path.
   */
  async resetShootState(): Promise<void> {
    return this.enqueueMutation(() => this._resetShootState());
  }

  private async _resetShootState(): Promise<void> {
    await this.ensureHydrated();
    this.memory = deepMerge(this.memory, {
      campaign: {
        ...this.memory.campaign,
        shootEngineQueued: false,
        shootConfirmed: false,
        shootBriefChoice: undefined,
        shootBrief: undefined,
        vibeChoice: undefined,
        vibeCandidates: undefined,
      },
    });
    await this.persist();
  }

  // The story equivalent of _resetShootState. StorytellerTool's "ask for
  // direction before inventing a narrative" gate reads creative.userBriefChoice/
  // userBrief/userContext and the story_* entries in answeredQuestions — none of
  // which ever cleared once set, so every story AFTER the first silently reused
  // the first one's answers and skipped straight to generating a narrative with
  // no question asked ("the creative director gave a storyline before asking").
  // Clearing them (and the stale narrative itself) makes each genuinely-new
  // story re-collect the brief. Mutates in place without persisting — the only
  // caller (orchestrate Phase 2) persists right after, inside the same lock.
  private static readonly STORY_GATE_QUESTIONS = ["story_brief_choice", "story_brief_custom", "story_context_gate"];

  private applyNewStoryReset(): void {
    this.memory = deepMerge(this.memory, {
      creative: {
        ...this.memory.creative,
        userBriefChoice: undefined,
        userBrief: undefined,
        userContext: undefined,
        story: undefined,
      },
      conversation: {
        ...this.memory.conversation,
        answeredQuestions: (this.memory.conversation?.answeredQuestions ?? []).filter(
          (q: string) => !Orchestrator.STORY_GATE_QUESTIONS.includes(q)
        ),
      },
    });
  }

  /**
   * Called by queue workers when an async tool finishes.
   * This is the RPC callback — must re-hydrate if DO hibernated.
   */
  async handleToolResult(
    tool: string,
    result: ToolResponse,
    jobId?: string,
    originalTask?: { id: string; tool: string; input?: any }
  ): Promise<void> {
    return this.enqueueMutation(() =>
      this._handleToolResult(tool, result, jobId, originalTask)
    );
  }

  // Internal callers (runNextStep's sync-tool path) must call this directly,
  // never the public handleToolResult() above — they already run inside a
  // queued mutation (orchestrate()/_handleToolResult() itself), and routing
  // back through the public wrapper would re-enqueue behind the very call
  // that's waiting on it, deadlocking the mutation queue forever.
  private async _handleToolResult(
    tool: string,
    result: ToolResponse,
    jobId?: string,
    originalTask?: { id: string; tool: string; input?: any }
  ): Promise<void> {
    // A real completion — disarm the failsafe watchdog before it can fire a
    // spurious duplicate "timed out" error on top of this actual result.
    if (jobId) this.disarmJobWatchdog(jobId);

    // DO may have hibernated between enqueue and callback — re-hydrate
    await this.ensureHydrated();

    // A stale/late-arriving signal for a shoot job that's since been
    // superseded (the shootEngineQueued guard TTL expired in
    // SimpleShootPlannerTool and a new shoot already started, or a delayed
    // retry of an already-abandoned queue message finally lands) must not
    // clobber the CURRENTLY active job's state — otherwise fixing the
    // stuck-guard problem just trades it for a race that silently corrupts a
    // legitimately in-flight newer job.
    const isShootJob = tool === 'shoot_engine' || tool === 'simple_shoot_engine';
    if (isShootJob && jobId && this.memory.flowControl.activeShootJobId && jobId !== this.memory.flowControl.activeShootJobId) {
      console.warn(`[Orchestrator] Ignoring stale ${tool} completion for job ${jobId} — active job is now ${this.memory.flowControl.activeShootJobId}`);
      return;
    }
    if (isShootJob && jobId && jobId === this.memory.flowControl.activeShootJobId) {
      this.memory.flowControl.activeShootJobId = undefined;
    }

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
    } else if (result.pauseForUserInput && originalTask) {
      // runNextStep() already shifted this task off the queue before running it,
      // so without this it vanishes from pendingTasks the moment it pauses on a
      // gate question. Phase 1 in orchestrate() only resumes via runNextStep()
      // when pendingTasks is non-empty — otherwise it falls through to a FRESH
      // IntentEngine.analyze() call that has no idea it's mid-flow inside this
      // specific tool and must blindly re-derive the same plan from the bare
      // answer text. That's fragile (it can, and does, skip this tool's next
      // internal gate — e.g. shoot_brief_choice="custom" answered but the
      // shoot_brief_custom follow-up never gets asked). Re-queuing the same task
      // makes resumption deterministic: answering the question always continues
      // THIS tool's next gate instead of gambling on a fresh plan reconstructing it.
      this.memory.flowControl.pendingTasks.unshift(originalTask);
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
            ? rawOptions.map((o: any) => ({ id: o.id, label: o.label, description: o.description }))
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
    return this.enqueueMutation(() => this._appendJobEvents(jobId, events));
  }

  private async _appendJobEvents(jobId: string, events: ChatEvent[]): Promise<{ cancelled: boolean }> {
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

    // Fire the abort signal immediately — must NOT wait behind the mutation
    // queue. The in-flight orchestrate()/runNextStep() step this is meant to
    // interrupt may itself currently be the thing occupying that queue,
    // blocked on a slow fetch/LLM call; queuing the abort behind it would mean
    // it never arrives in time to actually cancel anything.
    this.abortController.abort();

    // The rest is bookkeeping cleanup — queue it so it can't race with
    // whatever the interrupted step does as it unwinds (it may itself call
    // cleanup()/persist() once it observes the abort).
    return this.enqueueMutation(() => this._finishCancel());
  }

  private async _finishCancel(): Promise<{ success: boolean; message: string }> {
    this.isLocked = false;
    this.abortController = null;
    this.memory.flowControl.pendingTasks = [];

    // If a shoot queue job is running, write a cancellation flag.
    // The queue worker checks this flag via appendJobEvents and will throw to abort engine.run().
    const activeShootJobId = this.memory.flowControl.activeShootJobId;
    if (activeShootJobId) {
      this.disarmJobWatchdog(activeShootJobId);
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
        const interp = await this.interpretAnswer(message, attachments, pending);

        if (interp.decision === "answer") {
          // Resolved to an option (button click or reasoned from typed text) —
          // extractAnswer switches on option ids, so pass the canonical id.
          await this.extractAnswer(interp.optionId ?? message);

          if (this.memory.flowControl.pendingTasks.length > 0) {
            await this.runNextStep();
            return;
          }
          // No resume queued — fall through to Phase 2 with the answer already in
          // memory (unchanged from prior behavior).
        } else if (interp.decision === "clarify") {
          // On-topic but ambiguous. Keep BOTH the question and its queued
          // deterministic resume (avatar_finalize / resume_shoot_planner) intact
          // — the old code wiped them here, which is exactly what left avatar
          // generation dead — and just ask the user to disambiguate.
          await this.sendEvent({
            type: "chat_text",
            ai: "Just so I don't guess wrong — which of those did you mean?",
          });
          await this.sendEvent({ type: "done" });
          await this.cleanup();
          return;
        } else {
          // topic_change — the user has genuinely moved on. Drop the question and
          // its resume and let Phase 2 plan the new request fresh. extractAnswer
          // is deliberately skipped, so no low-confidence state is written.
          console.warn(`[Orchestrator] Reply treated as a new request, not an answer to "${pending.id}".`);
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

      // A genuinely new story request must re-collect the brief instead of
      // silently reusing the last story's answers. Story-gate state persists for
      // the life of the DO, so without this StorytellerTool's "ask before
      // inventing" gate is skipped on every story after the first. Safe here:
      // Phase 2 only runs for fresh requests — mid-story gate answers resume via
      // Phase 1 / pendingTasks and return before reaching this line, so this
      // never wipes an answer the user is currently in the middle of giving.
      if (plan.tasks.some((t) => t.tool === "storyteller")) {
        this.applyNewStoryReset();
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
        // MemoryServiceV3 (which MemoryTool wraps) expects a pre-built drizzle
        // DB instance on env.DB, not the raw DATABASE_URL connection string —
        // passing the bare Worker env left env.DB undefined, so every recall
        // silently threw "Cannot read properties of undefined (reading
        // 'select')" and degraded to a no-op (caught internally, but every
        // creative request was running with zero brand memory/context).
        return new MemoryTool({ ...(this.env as any), DB: getDb(this.env.DATABASE_URL) })
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
      // Call the private impl directly — runNextStep always runs inside a
      // queued mutation already (via orchestrate() or _handleToolResult()
      // itself); going through the public handleToolResult() would re-enqueue
      // behind the very call that's waiting on this one and deadlock.
      await this._handleToolResult(task.tool, result, undefined, task);
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
      this.armJobWatchdog(jobId, task.tool);
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

    // Single batched read instead of five separate storage.get() round trips —
    // also avoids a torn read against a concurrent persist() write, since a
    // multi-key get() is one storage transaction.
    const stored = await this.ctx.storage.get<any>([
      "memory",
      "history",
      "brandContext",
      "userId",
      "sessionKey",
    ]);

    this.memory = stored.get("memory") ?? {
      conversation: { answeredQuestions: [] },
      flowControl: { pendingQuestion: null, pendingTasks: [] },
    };
    this.history = stored.get("history") ?? [];
    this.brandContext = stored.get("brandContext") ?? {};
    this.userId = stored.get("userId") ?? "";
    this.sessionKey = stored.get("sessionKey") ?? "";
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
      sessionKey: this.sessionKey,
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

  // Resolves a user's reply to the pending question by REASONING about it, not
  // string-matching. Returns one of:
  //   - answer       → the reply picks an option; `optionId` is the canonical id
  //                    (extractAnswer switches on ids, so a typed "yeah the
  //                    second one" resolves the same as a button click).
  //   - topic_change → the reply ignores the question; abandon it and re-plan.
  //   - clarify      → on-topic but ambiguous; keep the question + its resume and
  //                    ask again (never silently abandon → that's what dropped
  //                    avatar generation).
  private async interpretAnswer(
    message: string,
    attachments: any[],
    pending: { id: string; options?: Array<{ id: string; label: string; description?: string }> }
  ): Promise<{ decision: "answer" | "topic_change" | "clarify"; optionId?: string }> {
    // Legacy question persisted before options were captured — nothing to reason
    // over, keep the old "always accept" behavior.
    if (pending.options === undefined) return { decision: "answer" };

    // An attachment mid-question means the user is doing something new (uploading
    // a product/reference), not answering — hand it to a fresh intent pass.
    if (attachments.length > 0) return { decision: "topic_change" };

    // Free-text gate — whatever they typed IS the answer; empty = nothing to act on.
    if (pending.options.length === 0) {
      return message.trim() ? { decision: "answer" } : { decision: "clarify" };
    }

    // Button click — the client sends the exact option id. This is a protocol
    // signal, not natural language, so it resolves with no LLM round-trip. (Exact
    // id equality only — NOT fuzzy label/keyword matching.)
    const clicked = pending.options.find((o) => o.id === message.trim());
    if (clicked) return { decision: "answer", optionId: clicked.id };

    // Anything typed goes straight to the model to reason about.
    return this.reasonAnswer(message, pending as { id: string; options: Array<{ id: string; label: string; description?: string }> });
  }

  private async reasonAnswer(
    message: string,
    pending: { id: string; options: Array<{ id: string; label: string; description?: string }> }
  ): Promise<{ decision: "answer" | "topic_change" | "clarify"; optionId?: string }> {
    const optionsBlock = pending.options
      .map((o) => `- id "${o.id}": ${o.label}${o.description ? ` — ${o.description}` : ""}`)
      .join("\n");

    const system = `You resolve a user's chat reply against the multiple-choice question they were just asked.
Reason about meaning, never keywords. Return ONLY JSON:
{"decision":"answer"|"topic_change"|"clarify","optionId":"<one of the exact option ids, only when decision is answer>"}
- "answer": the reply clearly selects or agrees with exactly one option — set optionId to that option's id.
- "topic_change": the reply ignores the question and asks for something else / a new direction.
- "clarify": on-topic but genuinely ambiguous between options, or too vague to pick one.
Never invent an option id.`;

    const user = `Question id: ${JSON.stringify(pending.id)}
Options:
${optionsBlock}

User's reply: ${JSON.stringify(message)}`;

    try {
      const raw = await this.textService.generateText({
        systemInstruction: system,
        contents: [{ role: "user", parts: [{ text: user }] }],
        config: { responseMimeType: "application/json" },
      } as any);
      const parsed = JSON.parse(raw.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim());

      if (parsed?.decision === "answer") {
        // Guard against a hallucinated id — only resume on an option that exists.
        const optionId = pending.options.find((o) => o.id === parsed?.optionId)?.id;
        return optionId ? { decision: "answer", optionId } : { decision: "clarify" };
      }
      if (parsed?.decision === "topic_change") return { decision: "topic_change" };
      return { decision: "clarify" };
    } catch (err: any) {
      // Interpreter unavailable/garbled — do NOT hard-abandon (that drops the
      // resume and re-asks). Fall back to clarify, keeping the question live.
      console.warn(`[Orchestrator] Answer interpretation failed for "${pending.id}":`, err?.message || err);
      return { decision: "clarify" };
    }
  }

  private async extractAnswer(message: string): Promise<void> {
    const pending = this.memory.flowControl.pendingQuestion;
    if (!pending) return;

    const EXTRACTORS: Record<string, (msg: string) => Partial<SessionMemory>> = {
      // Answering this question means "here's HOW I'll provide the product" —
      // it is NOT the product itself. Force-locking here regardless of value
      // used to make StorytellerTool/CreativeStudioTool believe a real product
      // existed the instant "upload" was picked, before any image had actually
      // been attached — they'd then generate a full narrative/plan from an
      // empty product object instead of waiting for real data. Only "describe"
      // sets awaitingProduct so the tool's gate captures the user's NEXT
      // message as the actual description before locking; "upload" resolves
      // itself naturally via resolveAttachments() once a real image lands.
      product_source: (v) => ({
        product: { ...this.memory.product, source: v, productLocked: this.memory.product?.productLocked ?? false },
        campaign: {
          ...this.memory.campaign,
          awaitingProduct: v === "describe" ? true : this.memory.campaign?.awaitingProduct,
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
      // avatarPrefs is stored as the raw option id ("diverse_urban", or a
      // dynamically LLM-generated id for AvatarGeneratorTool's brief-specific
      // options) — on its own that's meaningless to the blueprint-generation
      // step downstream. pending.options still holds this question's
      // {id, label} pairs at answer time, so capture the label too — losing
      // it meant the actual casting description ("Athletic build, energetic
      // vibe...") never survived past this one turn.
      avatar_prefs: (v) => ({
        campaign: {
          ...this.memory.campaign,
          avatarPrefs: v,
          avatarPrefsLabel: pending.options?.find((o) => o.id === v)?.label,
        },
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
      story_brief_choice: (v) => ({
        creative: { ...this.memory.creative, userBriefChoice: v },
      }),
      story_brief_custom: (v) => ({
        creative: { ...this.memory.creative, userBrief: v },
      }),
      // Free-text audience/goal/mood/must-include-avoid gathered after "Develop
      // it for me" — "skip" (or any close variant) means proceed with nothing,
      // not literally store the word "skip" as context.
      story_context_gate: (v) => ({
        creative: { ...this.memory.creative, userContext: /^\s*skip\s*$/i.test(v) ? "" : v },
      }),
      avatar_approval: (v) => ({
        campaign: { ...this.memory.campaign, avatarApproved: v === "approve" },
      }),
      avatar_reuse: (v) => {
        if (v === "__new__") {
          // avatarForShoot tells SimpleShootPlannerTool's Gate 2 to queue avatar_generator
          // immediately instead of re-fetching saved avatars and re-asking this same
          // question — without it, avatarImages stays empty, the gate re-runs, still finds
          // multiple saved avatars, and shows the identical "reuse or create new" picker
          // again — "Create a new one" was a dead-end loop with no way to actually get there.
          return { campaign: { ...this.memory.campaign, useAvatar: true, avatarForShoot: true } };
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
      // Without this, campaign.vibeChoice never gets set — SimpleShootPlannerTool's
      // Gate 1a checks `vibeChoice === undefined` to decide whether to (re-)fetch
      // Pinterest, so a missing extractor here means every vibe pick is silently a
      // no-op and the gate re-fires (re-scraping Pinterest, re-asking the same
      // question) on every subsequent turn instead of ever resolving.
      vibe_choice: (v) => {
        if (v === "custom") {
          return { campaign: { ...this.memory.campaign, vibeChoice: "custom", vibeCandidates: undefined } };
        }
        const candidates = this.memory.campaign?.vibeCandidates ?? [];
        const matched = candidates.find((c: any) => c.id === v);
        const briefAddition = matched?.description || matched?.title;
        return {
          campaign: {
            ...this.memory.campaign,
            vibeChoice: matched ?? v,
            vibeCandidates: undefined,
            shootBrief: [this.memory.campaign?.shootBrief, briefAddition].filter(Boolean).join(". ") || undefined,
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

  // Arms the last-resort timer for a queued shoot job (see jobWatchdogs
  // comment). If the queue never reports back — message lost, worker crash,
  // queue misconfigured locally — this is what turns an infinite silent hang
  // into a real error the user can see and act on, and releases the session
  // lock so the next message isn't rejected as "already locked".
  private armJobWatchdog(jobId: string, tool: string): void {
    const timer = setTimeout(() => {
      this.jobWatchdogs.delete(jobId);
      console.error(`[Orchestrator] Job ${jobId} (${tool}) never completed within ${Orchestrator.JOB_WATCHDOG_MS / 1000}s — failing it out.`);
      this.handleToolResult(
        tool,
        {
          visible: [{ type: 'error', message: 'This shoot timed out before finishing — please try again.' }],
          // Release the guard AND clear per-shoot vibe/brief so the next attempt
          // re-runs the vibe picker/brief gate instead of reusing this timed-out
          // shoot's pick (matches the queue-consumer + _resetShootState resets).
          memoryUpdate: { campaign: { shootEngineQueued: false, shootConfirmed: false, shootBriefChoice: undefined, shootBrief: undefined, vibeChoice: undefined, vibeCandidates: undefined } },
        },
        jobId
      ).catch((err) => console.error(`[Orchestrator] Job watchdog failsafe itself failed for ${jobId}:`, err));
    }, Orchestrator.JOB_WATCHDOG_MS);
    this.jobWatchdogs.set(jobId, timer);
  }

  private disarmJobWatchdog(jobId: string): void {
    const timer = this.jobWatchdogs.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.jobWatchdogs.delete(jobId);
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
