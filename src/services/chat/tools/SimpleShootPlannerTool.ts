import { Tool, ToolContext } from "./Tool";
import { ToolResponse } from "../../../types/chat";
import { getDb } from "../../../db";
import { assets, privateAssets } from "../../../db/schema";
import { eq, desc, inArray, and, isNotNull } from "drizzle-orm";
import { getSignedR2Url } from "../../../lib/r2";
import { fetchPinterestVibes, VibeOption } from "../../pinterest-vibe.service";

const UPLOAD_NEW_OPTION_ID = "__upload_new__";

// How long the "a shoot is already queued" guard is trusted before it's
// treated as stale and the tool proceeds as if nothing were queued. Generous
// upper bound on real generation time (see SimpleShootEngine.generateShotWithRetry —
// worst case ~3 shots x 3 retries x ~120s Fal poll each, plus LLM stages) —
// this is a last-resort self-heal, not the primary completion signal, so it
// errs long. Keep >= Orchestrator.JOB_WATCHDOG_MS so that failsafe (which
// clears the guard properly and reports an error) gets first shot at it.
const SHOOT_QUEUE_GUARD_TTL_MS = 25 * 60 * 1000;

export interface SimpleShootPlannerEnv {
  DATABASE_URL: string;
  ASSETS_BUCKET: any;
  API_URL?: string;
  // Vibe-picker gate — real Pinterest reference images, not AI-generated and
  // not the internal pinterest_assets Qdrant collection.
  PINTEREST_COOKIE?: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  STAGEHAND_ENV?: "BROWSERBASE" | "LOCAL";
  PINTEREST_EMAIL?: string;
  PINTEREST_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  VERTEX_PROJECT_ID?: string;
  VERTEX_LOCATION?: string;
  VERTEX_SERVICE_ACCOUNT_EMAIL?: string;
  VERTEX_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

interface AssetOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * Gates a chat-driven photoshoot request (asset → shoot vibe/brief → avatar
 * y/n → avatar casting → confirm), then hands off to the "simple_shoot_engine"
 * queued task (SimpleShootEngine — creative direction + Seedream generation, no
 * forensics). Adds an explicit asset-picker gate instead of silently
 * auto-locking to whatever resolveAttachments() found, and a shoot-brief/vibe
 * gate — including a live Pinterest vibe picker — that runs for every shoot
 * (avatar or product-only) before model casting, so the user steers the
 * concept instead of the creative-director stage improvising from a bare chat
 * message alone.
 *
 * Registered as "shoot_engine_planner" (via PhotoshootAgent) — keep this identity;
 * it's hardcoded into the intent-classifier prompt and every nextTasks chain that
 * hands off to this capability.
 */
export class SimpleShootPlannerTool implements Tool {
  name = "shoot_engine_planner";
  description =
    "Plans and triggers a product photoshoot: gates on product assets (offers existing project assets or upload), the creative brief/vibe (including a Pinterest vibe picker), and model preference (AI avatars or product-only), then generates the shots. Preferred tool for any photoshoot, lookbook, or campaign request.";

  constructor(private env: SimpleShootPlannerEnv) {}

  async run(input: any, ctx: ToolContext): Promise<ToolResponse> {
    // ── Guard: prevent double-queuing when this re-runs after avatar generation ─
    // Self-expiring: a plain boolean here can get permanently stuck if
    // whatever was supposed to clear it (job completion/failure callback)
    // never arrives — lost queue message, worker crash/reload mid-flight, a
    // dropped RPC back to this DO. None of those are rare enough to bet a
    // whole session's ability to ever shoot again on. Past the TTL, treat it
    // as abandoned and let the request through instead of silently no-op'ing
    // forever — worst case is one redundant/duplicate generation, which is
    // far better than a session that's dead until someone finds the debug
    // reset endpoint.
    const queuedAt = ctx.memory?.campaign?.shootEngineQueuedAt;
    const queueGuardStale = queuedAt !== undefined && Date.now() - queuedAt > SHOOT_QUEUE_GUARD_TTL_MS;
    if (ctx.memory?.campaign?.shootEngineQueued && !queueGuardStale) {
      return { visible: [] };
    }
    if (ctx.memory?.campaign?.shootEngineQueued && queueGuardStale) {
      console.warn("[SimpleShootPlannerTool] shootEngineQueued guard is stale — treating prior job as abandoned and proceeding.");
    }

    const answeredQuestions: string[] = ctx.memory?.conversation?.answeredQuestions ?? [];
    const projectId = ctx.memory?.projectId || ctx.memory?.campaign?.projectId;

    // ── Gate 0: product assets ───────────────────────────────────────────────
    // resolveAttachments() already ran this turn and may have silently locked a
    // product from prior assetRefs or a DB fallback — but only this-turn
    // attachments or an already-confirmed prior reference count as "already
    // decided" here. Anything else, ask explicitly instead of guessing.
    const hasThisTurnAttachment = (ctx.attachments?.length ?? 0) > 0;
    const hasConfirmedProductRef = (ctx.memory?.conversation?.assetRefs ?? []).some(
      (r: any) => r.role === "product"
    );
    const hasDescribedProduct = ctx.memory?.product?.source === "describe" && !!ctx.memory?.product?.productLocked;
    const askedAssetGate = answeredQuestions.includes("asset_selection");

    if (!hasThisTurnAttachment && !hasConfirmedProductRef && !hasDescribedProduct && !askedAssetGate) {
      // Already asked once (no existing assets to pick from, so the prior ask
      // was a plain "go ahead and upload, or describe it" prompt — not a
      // button). Still no attachment this turn means they replied with a
      // description instead of uploading — take that reply as the product
      // description rather than re-asking forever.
      if (ctx.memory?.campaign?.awaitingProduct && input.message?.trim()) {
        return {
          visible: [{ type: "status", content: "Got it — using your description for the product." }],
          memoryUpdate: {
            product: { ...ctx.memory?.product, source: "describe", description: input.message.trim(), productLocked: true },
            campaign: { ...ctx.memory?.campaign, awaitingProduct: false },
          },
        };
      }
      return this.askForAssets(projectId, ctx);
    }

    // ── Gate 1: shoot vibe/setting — runs BEFORE model casting, avatar or
    // product-only alike. The setting picked here (Pinterest reference or text
    // brief) is what the final composite (model + product + setting) uses, so
    // it has to be settled before avatar_generator casts a model blind to what
    // scene it'll end up in.
    //
    // NOTE: deliberately NOT gated on `answeredQuestions` (unlike the one-time
    // gates below, e.g. avatar_choice). answeredQuestions is a lifetime log
    // that never clears for the life of the session — brief/vibe are
    // per-SHOOT, reset to undefined whenever a shoot job completes. Gating on
    // the lifetime log would mean answering once silently skips asking again
    // on every later "make another one" in the same session. The resettable
    // value alone (vibeChoice/shootBriefChoice/shootBrief) is enough to avoid
    // re-asking within the SAME shoot, since extractAnswer sets it the moment
    // it's answered.
    {
      let vibeChoice = ctx.memory?.campaign?.vibeChoice;
      const pinterestConfigured = !!(this.env.PINTEREST_COOKIE || this.env.BROWSERBASE_API_KEY);

      // ── Gate 1a: vibe picker — real Pinterest reference images. Runs before
      // the plain-text brief question so the user has something concrete to
      // react to. Any failure/empty result falls through to the text-only
      // gate below — never blocks the shoot on Pinterest being reachable.
      if (pinterestConfigured && vibeChoice === undefined) {
        const query = this.buildVibeQuery(ctx, input);
        let candidates: VibeOption[] = [];
        try {
          // Hard timeout — the browser-automation fallback (Browserbase/
          // Stagehand) launches a real headless session with no timeout of
          // its own; a slow or hung network call here would otherwise block
          // this entire turn indefinitely with the user seeing nothing
          // happen, defeating the "never blocks the shoot" intent below.
          candidates = await Promise.race([
            fetchPinterestVibes(this.env, query, 4),
            new Promise<VibeOption[]>((_, reject) =>
              setTimeout(() => reject(new Error("Vibe search timed out")), 8_000)
            ),
          ]);
        } catch (err: any) {
          console.warn("[SimpleShootPlannerTool] Vibe search failed/timed out, falling back to text brief:", err.message);
        }

        if (candidates.length > 0) {
          return {
            pauseForUserInput: true,
            memoryUpdate: { campaign: { ...ctx.memory?.campaign, vibeCandidates: candidates } },
            visible: [
              { type: "shoot_images", items: candidates.map((c) => ({ url: c.imageUrl, concept: c.title })) },
              {
                type: "choice_questionnaire",
                questionId: "vibe_choice",
                content: {
                  title: "Pick a vibe",
                  question: "Real references for this shoot — pick a direction, or describe your own.",
                  options: [
                    ...candidates.map((c) => ({ id: c.id, label: c.title, description: c.description?.slice(0, 120) })),
                    { id: "custom", label: "None of these", description: "I'll describe the mood/setting myself." },
                  ],
                },
              },
            ],
          };
        }
        // No usable results this turn — treat like the user picked "describe it
        // myself" so we don't retry a live Pinterest fetch on every subsequent
        // turn of this same shoot.
        vibeChoice = "custom";
      }

      const shootBriefChoice = ctx.memory?.campaign?.shootBriefChoice;
      // Vibe picker already resolved a real reference and folded it into
      // shootBrief (Orchestrator's vibe_choice extractor) — no need to also
      // ask the ai_decide/custom question. Only "custom" (explicit or via a
      // failed search) still needs the ai_decide-vs-custom fork.
      const vibeResolved = vibeChoice !== undefined && vibeChoice !== "custom";
      // StorytellerTool already ran and produced a full narrative (mood, world,
      // lighting, color direction — StorytellerTool.developCreativeDirection),
      // and its own pre-generation gate (story_brief_choice/story_context_gate)
      // already asked the user this same question in substance. Re-asking
      // "any specific mood/setting/style?" here is a duplicate the user has
      // already answered moments earlier — treat the story as resolving this
      // gate instead. briefParts below already folds creative.story into the
      // final query, so nothing is lost by skipping shootBrief here.
      const storyResolved = !!ctx.memory?.creative?.story;

      if (!vibeResolved && !storyResolved && !shootBriefChoice) {
        return {
          pauseForUserInput: true,
          memoryUpdate: vibeChoice === "custom" ? { campaign: { ...ctx.memory?.campaign, vibeChoice: "custom" } } : undefined,
          visible: [{
            type: "choice_questionnaire",
            questionId: "shoot_brief_choice",
            content: {
              title: "Shoot direction",
              question: "Any specific mood, setting, or style for this shoot?",
              options: [
                { id: "ai_decide", label: "Let AI decide", description: "Develop a creative concept from your brief and brand style." },
                { id: "custom", label: "I'll describe it", description: "Tell me the mood, setting, or style you want." },
              ],
            },
          }],
        };
      }

      if (!vibeResolved && !storyResolved && shootBriefChoice === "custom" && !ctx.memory?.campaign?.shootBrief) {
        return {
          pauseForUserInput: true,
          visible: [{
            type: "choice_questionnaire",
            questionId: "shoot_brief_custom",
            content: {
              title: "Describe the shoot",
              question: "What mood, setting, or style do you want for this shoot?",
              options: [],
            },
          }],
        };
      }
    }

    // ── Gate 2: avatar preference ─────────────────────────────────────────────
    const useAvatar = ctx.memory?.campaign?.useAvatar;
    const answeredAvatarChoice = answeredQuestions.includes("avatar_choice");

    if (useAvatar === undefined && !answeredAvatarChoice) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "avatar_choice",
          content: {
            title: "Model direction",
            question: "Do you want human models (AI avatars) in these shots, or product-only?",
            options: [
              { id: "use_avatar", label: "Yes, add AI models", description: "We'll generate AI avatars styled to your brand." },
              { id: "product_only", label: "Product only", description: "Clean product shots — no models." },
            ],
          },
        }],
      };
    }

    // ── Gate 3: avatar requested but not yet generated → reuse saved, ask which,
    // or generate a brand new one ───────────────────────────────────────────
    const avatarImages: any[] = ctx.memory?.campaign?.avatarImages ?? [];
    if (useAvatar && avatarImages.length === 0) {
      // User already declined all saved avatars via the avatar_reuse picker
      // ("Create a new one") — avatarForShoot is set by that extractor
      // specifically to short-circuit straight to generation here. Without
      // this check, avatarImages is still empty, so the code below falls
      // through to re-fetching saved avatars and showing the identical
      // reuse-or-create-new picker again — a dead-end loop with no way to
      // actually reach avatar_generator.
      if (ctx.memory?.campaign?.avatarForShoot) {
        return {
          visible: [{ type: "status", content: "Let's create your AI models first — then we'll shoot with them." }],
          nextTasks: [
            { id: "gen_avatars", tool: "avatar_generator" as any, input: {} },
            { id: "resume_shoot_planner", tool: "shoot_engine_planner" as any, input: {} },
          ],
        };
      }

      // An "@Name" mention in the user's message resolves directly to a saved
      // avatar, skipping the picker entirely.
      const mention = (input.message || "").match(/@(\w+)/)?.[1]?.toLowerCase();
      const savedAvatars = ctx.userId && ctx.userId !== "anon"
        ? await this.listSavedAvatars(ctx.userId)
        : [];

      if (mention) {
        const matched = savedAvatars.find((a) => a.name.toLowerCase() === mention);
        if (matched) {
          return {
            visible: [{ type: "status", content: `Using ${matched.name} from your avatar library.` }],
            memoryUpdate: {
              campaign: { ...ctx.memory?.campaign, avatarImages: matched.images, useAvatar: true },
            },
          };
        }
      }

      if (savedAvatars.length === 1) {
        return {
          visible: [{ type: "status", content: `Using ${savedAvatars[0].name} from your avatar library.` }],
          memoryUpdate: {
            campaign: { ...ctx.memory?.campaign, avatarImages: savedAvatars[0].images, useAvatar: true },
          },
        };
      }

      if (savedAvatars.length > 1) {
        return {
          pauseForUserInput: true,
          memoryUpdate: {
            campaign: { ...ctx.memory?.campaign, savedAvatarsChoice: savedAvatars },
          },
          visible: [{
            type: "choice_questionnaire",
            questionId: "avatar_reuse",
            content: {
              title: "Which model?",
              question: "You've got saved AI models — want to shoot with one of them, or create a new one? (You can also just say \"use @Name\" next time.)",
              options: [
                ...savedAvatars.map((a) => ({ id: a.id, label: a.name, description: "Saved model" })),
                { id: "__new__", label: "Create a new one", description: "Cast a fresh model for this shoot." },
              ],
            },
          }],
          // Deterministic resume — the answer only updates memory, this queued
          // task actually continues the shoot once it's answered.
          nextTasks: [{ id: "resume_shoot_planner_after_avatar_choice", tool: "shoot_engine_planner" as any, input: {} }],
        };
      }

      return {
        visible: [{ type: "status", content: "Let's create your AI models first — then we'll shoot with them." }],
        memoryUpdate: { campaign: { ...ctx.memory?.campaign, avatarForShoot: true } },
        nextTasks: [
          { id: "gen_avatars", tool: "avatar_generator" as any, input: {} },
          { id: "resume_shoot_planner", tool: "shoot_engine_planner" as any, input: {} },
        ],
      };
    }

    // ── Asset verification: a memory reference isn't proof the R2 object still
    // exists (e.g. stale DB rows from a wiped local bucket). Check before handing
    // off to generation rather than let SimpleShootEngine silently fall back to a
    // referenceless shoot — if nothing resolves, ask again instead.
    const assetIds: string[] = ctx.memory?.product?.assetIds?.length
      ? ctx.memory.product.assetIds
      : ctx.memory?.product?.primaryAssetId
        ? [ctx.memory.product.primaryAssetId]
        : [];

    if (assetIds.length > 0 && !(await this.anyAssetExists(assetIds))) {
      console.warn("[SimpleShootPlannerTool] None of the referenced assets exist in R2 — re-asking:", assetIds);
      return this.askForAssets(projectId, ctx, assetIds);
    }

    // ── Gate 4: confirm assets + shot count — ALWAYS ask, every time, even within
    // an already-running session. `answeredQuestions` never clears (it's a
    // lifetime log), so it can't gate a "confirm this every request" step —
    // `shootConfirmed` is a resettable flag instead (cleared once the shoot job
    // actually finishes, alongside shootEngineQueued). Without this, a second
    // "make me a shoot" later in the same session would silently reuse whatever
    // assets/count happened to be in memory from the first one, with zero
    // generation actually starting before the user has seen or confirmed them.
    if (!ctx.memory?.campaign?.shootConfirmed) {
      const assetLabels = assetIds.length > 0 ? await this.describeAssets(assetIds) : [];
      const usingText = assetLabels.length > 0
        ? `Using: ${assetLabels.join(", ")}.`
        : "No product reference — this will be a text-to-image shoot.";

      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "shoot_confirm",
          content: {
            title: "Ready to generate",
            question: `${usingText} How many shots do you want?`,
            options: [
              { id: "1", label: "1 shot" },
              { id: "2", label: "2 shots" },
              { id: "3", label: "3 shots" },
              { id: "change_assets", label: "Use different assets", description: "Pick or upload a different product image" },
            ],
          },
        }],
      };
    }

    // ── All gates cleared: build query and queue simple_shoot_engine ──────────
    // Lead with the brand NARRATIVE so the shoot's world is grounded in the story
    // (setting, emotion, "belongs in ___" directive), then any explicit shoot
    // brief/vibe. Raw chat filler (input.message, e.g. "okay lets start") is
    // deliberately excluded — a genuine custom brief is already captured in
    // campaign.shootBrief via the shoot_brief_custom gate, so folding the current
    // turn's message in here only injects noise the Creative Director then has to
    // reconcile against the story.
    const briefParts = [
      ctx.memory?.creative?.story,
      ctx.memory?.campaign?.shootBrief,
      useAvatar ? "Include the AI model wearing/using the product." : "",
    ].filter(Boolean);
    const query = briefParts.join(". ") || "Professional product photoshoot";

    const resolvedProjectId = projectId || input.projectId || "default";
    const userId = ctx.userId || "anon";
    const count = ctx.memory?.campaign?.shootCount ?? 1;
    const vibeChoice = ctx.memory?.campaign?.vibeChoice;
    const vibeImageUrl = vibeChoice && typeof vibeChoice === "object" ? (vibeChoice as any).imageUrl : undefined;

    return {
      visible: [{
        type: "status",
        content: `Shoot ready — generating${useAvatar ? " with your AI model" : ""}...`,
      }],
      memoryUpdate: { campaign: { ...ctx.memory?.campaign, shootEngineQueued: true, shootEngineQueuedAt: Date.now() } },
      nextTasks: [{
        id: `simple_shoot_engine_${Date.now()}`,
        tool: "simple_shoot_engine" as any,
        input: {
          query, assetIds, projectId: resolvedProjectId, userId, count,
          // Cast avatar's reference image(s) — without this the engine only
          // gets a text hint ("include the AI model") with nothing to
          // actually render the model's likeness from.
          modelR2Keys: useAvatar
            ? avatarImages.map((a: any) => a.r2Key).filter(Boolean)
            : undefined,
          // Real Pinterest reference the user picked in the vibe-picker gate —
          // fed to the Creative Director as an actual mood image, not just the
          // text description already folded into shootBrief above.
          vibeImageUrl,
        },
      }],
    };
  }

  // Query for the vibe-picker's live Pinterest search. When a story/creative
  // direction already exists (StorytellerTool ran first), its background_queries
  // (pure setting/atmosphere, no product/garment terms) are what should drive
  // this — deliberately NOT search_queries, which are StorytellerTool's own
  // internal moodboard-DB lookup field and always include the product type,
  // which would just re-search the product itself instead of the shoot's
  // background/setting. Only fall back to a product-description query when
  // there's no story yet (shoot-only flow, no storyteller run this session).
  private buildVibeQuery(ctx: ToolContext, input: any): string {
    const backgroundQueries: string[] = ctx.memory?.creative?.canvasInfo?.moodboard?.background_queries || [];
    if (backgroundQueries.length > 0) {
      return backgroundQueries.slice(0, 2).join(" ").trim();
    }

    // Fallback (no story background_queries yet): describe the product and its
    // creative aesthetic for a SETTING search. Deliberately excludes
    // brandContext.industry and the raw chat message — for an off-category
    // product (e.g. a breakfast item under a streetwear label) the brand's
    // industry ("clothing") and turn filler ("okay lets start") only drag the
    // vibe search toward the wrong world.
    const parts = [
      ctx.memory?.product?.name,
      ctx.memory?.product?.tags?.join(" "),
      ctx.memory?.creative?.style?.aesthetic,
    ].filter(Boolean);
    return parts.join(" ").trim() || "product photography editorial";
  }

  // Saved avatars aren't a separate table — they're privateAssets rows (type:
  // "avatar") that got labeled with a name when the user approved them
  // (AvatarGeneratorTool.finalizeApprovedAvatar). Unlabeled avatar rows are
  // unapproved/rejected generation attempts and are excluded here.
  private async listSavedAvatars(userId: string): Promise<Array<{ id: string; name: string; images: any[] }>> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const rows = await db.select().from(privateAssets).where(and(
        eq(privateAssets.userId, userId),
        eq(privateAssets.type, "avatar"),
        isNotNull(privateAssets.label),
      )).orderBy(desc(privateAssets.createdAt));

      return Promise.all(rows.map(async (r) => {
        let signedUrl: string;
        try {
          signedUrl = await getSignedR2Url(this.env.ASSETS_BUCKET, r.r2Key, 7200);
        } catch {
          signedUrl = `${this.env.API_URL || ""}/assets/download?key=${encodeURIComponent(r.r2Key)}`;
        }
        return {
          id: r.id,
          name: r.label as string,
          images: [{ angleId: (r.metadata as any)?.angleId || "front", r2Key: r.r2Key, signedUrl }],
        };
      }));
    } catch (err) {
      console.warn("[SimpleShootPlannerTool] Failed to load saved avatars:", err);
      return [];
    }
  }

  private async describeAssets(assetIds: string[]): Promise<string[]> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const [publicRows, privateRows] = await Promise.all([
        db.select().from(assets).where(inArray(assets.id, assetIds)),
        db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds)),
      ]);
      return [...publicRows, ...privateRows].map(
        (a: any) => a.parsedData?.name || a.type || "product image"
      );
    } catch (err) {
      console.warn("[SimpleShootPlannerTool] Failed to describe assets:", err);
      return [];
    }
  }

  // Checks whether at least one of the given asset ids still has a real R2 object
  // behind it. Cheap — HEAD only, no body download.
  private async anyAssetExists(assetIds: string[]): Promise<boolean> {
    try {
      const db = getDb(this.env.DATABASE_URL);
      const [publicRows, privateRows] = await Promise.all([
        db.select().from(assets).where(inArray(assets.id, assetIds)),
        db.select().from(privateAssets).where(inArray(privateAssets.id, assetIds)),
      ]);
      const r2Keys = [...publicRows.map((a) => a.url), ...privateRows.map((a) => a.r2Key)];

      const heads = await Promise.all(r2Keys.map((key) => this.env.ASSETS_BUCKET.head(key)));
      return heads.some((h) => h !== null);
    } catch (err) {
      // Non-fatal — if the check itself fails, don't block the shoot over it.
      console.warn("[SimpleShootPlannerTool] Asset existence check failed, proceeding anyway:", err);
      return true;
    }
  }

  private async askForAssets(projectId: string | undefined, ctx: ToolContext, excludeIds: string[] = []): Promise<ToolResponse> {
    let existingAssets: AssetOption[] = [];

    if (projectId) {
      try {
        const db = getDb(this.env.DATABASE_URL);
        const rows = await db
          .select()
          .from(assets)
          .where(eq(assets.projectId, projectId))
          .orderBy(desc(assets.createdAt))
          .limit(5 + excludeIds.length);
        existingAssets = rows
          .filter((a) => !excludeIds.includes(a.id))
          .slice(0, 5)
          .map((a) => ({
            id: a.id,
            label: (a.parsedData as any)?.name || a.type || "Uploaded asset",
            description: Array.isArray(a.tags) && a.tags.length ? (a.tags as string[]).join(", ") : undefined,
          }));
      } catch (err) {
        // Non-fatal — fall through to the plain upload/describe prompt.
        console.warn("[SimpleShootPlannerTool] Failed to load existing project assets:", err);
      }
    }

    // Existing assets are a real choice worth buttons for (which one?).
    if (existingAssets.length > 0) {
      return {
        pauseForUserInput: true,
        visible: [{
          type: "choice_questionnaire",
          questionId: "asset_selection",
          content: {
            title: "Which product?",
            question: excludeIds.length > 0
              ? "That asset couldn't be found — want to use a different one, or add a new one?"
              : "Want to use one of your existing assets, or add a new one?",
            options: [
              ...existingAssets.map((a) => ({ id: a.id, label: a.label, description: a.description })),
              { id: UPLOAD_NEW_OPTION_ID, label: "Upload something new", description: "Share a new product photo." },
            ],
          },
        }],
      };
    }

    // No existing assets — nothing to actually choose between, so don't gate
    // this behind a button. Uploading is just the user's turn to act (via the
    // input's own upload control); a plain prompt covers it, and they can
    // reply with a description instead if they don't have a photo.
    return {
      memoryUpdate: { campaign: { ...ctx.memory?.campaign, awaitingProduct: true } },
      visible: [{
        type: "chat_text",
        ai: excludeIds.length > 0
          ? "That asset couldn't be found — go ahead and upload your product image, or describe it here if you don't have one handy."
          : "I need a product image to generate the shoot — go ahead and upload one, or just describe it here if you don't have a photo handy.",
      }],
    };
  }
}
